// @ts-check
import axios from "axios";
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import {
  CustomError,
  logger,
  MissingParamError,
  request,
  wrapTextMultiline,
} from "../common/utils.js";

dotenv.config();

// GraphQL queries.
const GRAPHQL_REPOS_FIELD = `
  repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}, after: $after) {
    totalCount
    nodes {
      name
      stargazers {
        totalCount
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

const GRAPHQL_REPOS_QUERY = `
  query userInfo($login: String!, $after: String) {
    user(login: $login) {
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

const GRAPHQL_PROFILE_FIELDS = `
      name
      login
      pullRequests(first: 1) {
        totalCount
      }
      mergedPullRequests: pullRequests(states: MERGED) @include(if: $includeMergedPullRequests) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      followers {
        totalCount
      }
      repositoryDiscussions @include(if: $includeDiscussions) {
        totalCount
      }
      repositoryDiscussionComments(onlyAnswers: true) @include(if: $includeDiscussionsAnswers) {
        totalCount
      }
      ${GRAPHQL_REPOS_FIELD}
`;

// GitHub's GraphQL API enforces a per-query execution budget and rejects
// queries exceeding it with RESOURCE_LIMITS_EXCEEDED (observed since around
// 2026-07-17). For accounts with large contribution histories the budget
// allows at most one contribution aggregation per query, and the all-time
// repositoriesContributedTo field exceeds it on its own. The stats query is
// therefore split into parts, each carrying at most one aggregation, with
// contributionsCollection.totalRepositoriesWithContributedCommits standing in
// for repositoriesContributedTo. The stand-in only counts repositories with
// commit contributions within the last year, which still matches the
// "Contributed to (last year)" card label.
const GRAPHQL_STATS_QUERY_PARTS = {
  profile: GRAPHQL_PROFILE_FIELDS,
  commits: `
      contributionsCollection {
        totalCommitContributions
      }
`,
  reviews: `
      contributionsCollection {
        totalPullRequestReviewContributions
      }
`,
  contributedTo: `
      contributionsCollection {
        totalRepositoriesWithContributedCommits
      }
`,
};

const GRAPHQL_STATS_QUERY_FULL_FIELDS = `
      contributionsCollection {
        totalCommitContributions,
        totalPullRequestReviewContributions
      }
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
        totalCount
      }
      ${GRAPHQL_PROFILE_FIELDS}
`;

/**
 * Build the stats GraphQL query.
 *
 * GitHub rejects queries that declare unused variables, so the aggregation
 * parts only declare $login.
 *
 * @param {keyof GRAPHQL_STATS_QUERY_PARTS | undefined} part Stats query part to build; the full query when undefined.
 * @returns {string} GraphQL query.
 */
const buildStatsQuery = (part) => {
  const declarations =
    part && part !== "profile"
      ? "$login: String!"
      : "$login: String!, $after: String, $includeMergedPullRequests: Boolean!, $includeDiscussions: Boolean!, $includeDiscussionsAnswers: Boolean!";
  return `
  query userInfo(${declarations}) {
    user(login: $login) {
${part ? GRAPHQL_STATS_QUERY_PARTS[part] : GRAPHQL_STATS_QUERY_FULL_FIELDS}
    }
  }
`;
};

/**
 * @typedef {import('axios').AxiosResponse} AxiosResponse Axios response.
 */

/**
 * Stats fetcher object.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<AxiosResponse>} Axios response.
 */
const fetcher = (variables, token) => {
  const query = variables.after
    ? GRAPHQL_REPOS_QUERY
    : buildStatsQuery(variables.statsQueryPart);
  return request(
    {
      query,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Check whether a response body is not shaped like a GraphQL response.
 *
 * GitHub occasionally answers overloaded queries with an HTML error page and
 * status 200; treating it as GraphQL data crashes the fetcher.
 *
 * @param {AxiosResponse} res Axios response.
 * @returns {boolean} True when the body has neither data nor errors.
 */
const isMalformedGraphQLResponse = (res) =>
  !res.data ||
  typeof res.data !== "object" ||
  (!res.data.data && !res.data.errors);

/**
 * Fetch the stats query in parts, each within GitHub's per-query resource
 * budget, and merge them into a single response.
 *
 * @param {object} variables Fetcher variables.
 * @returns {Promise<AxiosResponse>} Axios response shaped like the full stats query.
 */
const splitStatsFetcher = async (variables) => {
  const parts = ["profile", "commits", "reviews", "contributedTo"];
  // Fetched sequentially: firing the parts concurrently makes GitHub reject
  // or drop some of them (5xx / empty responses) for accounts already at the
  // edge of the resource budget, while the same queries succeed one at a time.
  const responses = [];
  for (const part of parts) {
    const res = await retryer(fetcher, { ...variables, statsQueryPart: part });
    if (isMalformedGraphQLResponse(res)) {
      throw new CustomError(
        "GitHub GraphQL API returned an unexpected response.",
        CustomError.GRAPHQL_ERROR,
      );
    }
    if (res.data.errors) {
      return res;
    }
    responses.push(res);
  }
  const [profile, ...aggregations] = responses;
  profile.data.data.user.contributionsCollection = Object.assign(
    {},
    ...aggregations.map((res) => res.data.data.user.contributionsCollection),
  );
  return profile;
};

/**
 * Fetch stats information for a given username.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.username Github username.
 * @param {boolean} variables.includeMergedPullRequests Include merged pull requests.
 * @param {boolean} variables.includeDiscussions Include discussions.
 * @param {boolean} variables.includeDiscussionsAnswers Include discussions answers.
 * @returns {Promise<AxiosResponse>} Axios response.
 *
 * @description This function supports multi-page fetching if the 'FETCH_MULTI_PAGE_STARS' environment variable is set to true.
 */
const statsFetcher = async ({
  username,
  includeMergedPullRequests,
  includeDiscussions,
  includeDiscussionsAnswers,
}) => {
  let stats;
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const variables = {
      login: username,
      first: 100,
      after: endCursor,
      includeMergedPullRequests,
      includeDiscussions,
      includeDiscussionsAnswers,
    };
    let res = await retryer(fetcher, variables);
    const malformed = isMalformedGraphQLResponse(res);
    if (malformed || res.data.errors) {
      const isResourceLimited =
        !malformed &&
        res.data.errors.some(
          (error) => error?.type === "RESOURCE_LIMITS_EXCEEDED",
        );
      // A malformed 200 response (e.g. an HTML error page) is treated as
      // another overload symptom and retried as split queries.
      if ((isResourceLimited || malformed) && !endCursor) {
        logger.log(
          "Stats query exceeded GitHub resource limits or returned an unexpected response. Retrying as split queries.",
        );
        res = await splitStatsFetcher(variables);
      }
      if (isMalformedGraphQLResponse(res)) {
        throw new CustomError(
          "GitHub GraphQL API returned an unexpected response.",
          CustomError.GRAPHQL_ERROR,
        );
      }
      if (res.data.errors) {
        return res;
      }
    }

    // Store stats data.
    const repoNodes = res.data.data.user.repositories.nodes;
    if (stats) {
      stats.data.data.user.repositories.nodes.push(...repoNodes);
    } else {
      stats = res;
    }

    // Disable multi page fetching on public Vercel instance due to rate limits.
    const repoNodesWithStars = repoNodes.filter(
      (node) => node.stargazers.totalCount !== 0,
    );
    hasNextPage =
      process.env.FETCH_MULTI_PAGE_STARS === "true" &&
      repoNodes.length === repoNodesWithStars.length &&
      res.data.data.user.repositories.pageInfo.hasNextPage;
    endCursor = res.data.data.user.repositories.pageInfo.endCursor;
  }

  return stats;
};

/**
 * Fetch all the commits for all the repositories of a given username.
 *
 * @param {string} username GitHub username.
 * @returns {Promise<number>} Total commits.
 *
 * @description Done like this because the GitHub API does not provide a way to fetch all the commits. See
 * #92#issuecomment-661026467 and #211 for more information.
 */
const totalCommitsFetcher = async (username) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new Error("Invalid username provided.");
  }

  // https://developer.github.com/v3/search/#search-commits
  const fetchTotalCommits = (variables, token) => {
    return axios({
      method: "get",
      url: `https://api.github.com/search/commits?q=author:${variables.login}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github.cloak-preview",
        Authorization: `token ${token}`,
      },
    });
  };

  let res;
  try {
    res = await retryer(fetchTotalCommits, { login: username });
  } catch (err) {
    logger.log(err);
    throw new Error(err);
  }

  const totalCount = res.data.total_count;
  if (!totalCount || isNaN(totalCount)) {
    throw new CustomError(
      "Could not fetch total commits.",
      CustomError.GITHUB_REST_API_ERROR,
    );
  }
  return totalCount;
};

/**
 * @typedef {import("./types").StatsData} StatsData Stats data.
 */

/**
 * Fetch stats for a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} include_all_commits Include all commits.
 * @param {string[]} exclude_repo Repositories to exclude.
 * @param {boolean} include_merged_pull_requests Include merged pull requests.
 * @param {boolean} include_discussions Include discussions.
 * @param {boolean} include_discussions_answers Include discussions answers.
 * @returns {Promise<StatsData>} Stats data.
 */
const fetchStats = async (
  username,
  include_all_commits = false,
  exclude_repo = [],
  include_merged_pull_requests = false,
  include_discussions = false,
  include_discussions_answers = false,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  const stats = {
    name: "",
    totalPRs: 0,
    totalPRsMerged: 0,
    mergedPRsPercentage: 0,
    totalReviews: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    totalDiscussionsStarted: 0,
    totalDiscussionsAnswered: 0,
    contributedTo: 0,
    rank: { level: "C", percentile: 100 },
  };

  let res = await statsFetcher({
    username,
    includeMergedPullRequests: include_merged_pull_requests,
    includeDiscussions: include_discussions,
    includeDiscussionsAnswers: include_discussions_answers,
  });

  // Catch GraphQL errors.
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went wrong while trying to retrieve the stats data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;

  // if include_all_commits, fetch all commits using the REST API.
  if (include_all_commits) {
    stats.totalCommits = await totalCommitsFetcher(username);
  } else {
    stats.totalCommits = user.contributionsCollection.totalCommitContributions;
  }

  stats.totalPRs = user.pullRequests.totalCount;
  if (include_merged_pull_requests) {
    stats.totalPRsMerged = user.mergedPullRequests.totalCount;
    stats.mergedPRsPercentage =
      (user.mergedPullRequests.totalCount / user.pullRequests.totalCount) * 100;
  }
  stats.totalReviews =
    user.contributionsCollection.totalPullRequestReviewContributions;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;
  if (include_discussions) {
    stats.totalDiscussionsStarted = user.repositoryDiscussions.totalCount;
  }
  if (include_discussions_answers) {
    stats.totalDiscussionsAnswered =
      user.repositoryDiscussionComments.totalCount;
  }
  stats.contributedTo = user.repositoriesContributedTo
    ? user.repositoriesContributedTo.totalCount
    : user.contributionsCollection.totalRepositoriesWithContributedCommits;

  // Retrieve stars while filtering out repositories to be hidden.
  let repoToHide = new Set(exclude_repo);

  stats.totalStars = user.repositories.nodes
    .filter((data) => {
      return !repoToHide.has(data.name);
    })
    .reduce((prev, curr) => {
      return prev + curr.stargazers.totalCount;
    }, 0);

  stats.rank = calculateRank({
    all_commits: include_all_commits,
    commits: stats.totalCommits,
    prs: stats.totalPRs,
    reviews: stats.totalReviews,
    issues: stats.totalIssues,
    repos: user.repositories.totalCount,
    stars: stats.totalStars,
    followers: user.followers.totalCount,
  });

  return stats;
};

export { fetchStats };
export default fetchStats;
