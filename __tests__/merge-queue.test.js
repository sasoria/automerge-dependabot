import { jest, describe, beforeEach, test, expect } from '@jest/globals';
import * as core from '../__fixtures__/core.js';
import * as github from '../__fixtures__/github.js';

const mockAddWorkflowSummary = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../src/summary.js', () => ({
  addWorkflowSummary: mockAddWorkflowSummary
}));
jest.unstable_mockModule('@actions/core', () => core);
jest.unstable_mockModule('@actions/github', () => github);

const { run } = await import('../src/index.js');
const { parseMergeQueueMode, branchHasMergeQueue, enqueuePullRequest } = await import('../src/pullRequests.js');
const { getFilterReasons, clearFilterReasons } = await import('../src/filters.js');
const { setupTestEnvironment, createMockPR } = await import('./helpers/mockSetup.js');

const prDetails = (number, overrides = {}) => ({
  number,
  node_id: `PR_node${number}`,
  mergeable: true,
  mergeable_state: 'blocked',
  head: { sha: `sha${number}` },
  base: { ref: 'main' },
  ...overrides
});

const enqueueResponse = (position = 1) => ({
  enqueuePullRequest: { mergeQueueEntry: { position, state: 'QUEUED' } }
});

describe('Merge queue support', () => {
  let mockOctokit;

  const setup = (inputOverrides = {}) => {
    jest.clearAllMocks();
    if (typeof clearFilterReasons === 'function') {
      clearFilterReasons();
    }
    const result = setupTestEnvironment(core, github, {
      inputOverrides: { 'retry-delay-ms': '1', ...inputOverrides }
    });
    mockOctokit = result.mockOctokit;
    mockOctokit.rest.pulls.list.mockResolvedValue({
      data: [
        createMockPR({ number: 1, title: 'Bump lodash from 4.17.20 to 4.17.21', head: { sha: 'sha1' } }),
        createMockPR({ number: 2, title: 'Bump axios from 0.21.1 to 0.21.4', head: { sha: 'sha2' } })
      ]
    });
    mockOctokit.rest.pulls.get.mockImplementation(({ pull_number }) => Promise.resolve({ data: prDetails(pull_number) }));
  };

  beforeEach(() => setup());

  test('enqueues PRs instead of merging when the base branch has a merge queue', async () => {
    mockOctokit.rest.repos.getBranchRules.mockResolvedValue({
      data: [{ type: 'pull_request' }, { type: 'merge_queue', parameters: {} }]
    });
    mockOctokit.graphql
      .mockResolvedValueOnce(enqueueResponse(1))
      .mockResolvedValueOnce(enqueueResponse(2));

    await run();

    expect(mockOctokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
    expect(mockOctokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('enqueuePullRequest'),
      { pullRequestId: 'PR_node1', expectedHeadOid: 'sha1' }
    );
    expect(mockOctokit.graphql).toHaveBeenCalledWith(
      expect.stringContaining('enqueuePullRequest'),
      { pullRequestId: 'PR_node2', expectedHeadOid: 'sha2' }
    );

    // Detection is cached per base branch
    expect(mockOctokit.rest.repos.getBranchRules).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.repos.getBranchRules).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner', repo: 'repo', branch: 'main' })
    );

    expect(core.setOutput).toHaveBeenCalledWith('merged-pr-count', 0);
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 2);
    expect(core.setFailed).not.toHaveBeenCalled();

    const queued = mockAddWorkflowSummary.mock.calls[0][5];
    expect([...queued]).toEqual([1, 2]);
  });

  test('merges directly when the base branch has no merge queue', async () => {
    mockOctokit.rest.repos.getBranchRules.mockResolvedValue({ data: [{ type: 'pull_request' }] });

    await run();

    expect(mockOctokit.graphql).not.toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.merge).toHaveBeenCalledTimes(2);
    expect(core.setOutput).toHaveBeenCalledWith('merged-pr-count', 2);
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 0);
  });

  test('fails the run and records a reason when enqueue fails', async () => {
    mockOctokit.rest.repos.getBranchRules.mockResolvedValue({ data: [{ type: 'merge_queue' }] });
    mockOctokit.graphql
      .mockRejectedValueOnce(new Error('Resource not accessible by integration'))
      .mockResolvedValueOnce(enqueueResponse(1));

    await run();

    expect(mockOctokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Failed to add PR #1 to the merge queue: Resource not accessible by integration')
    );
    expect(getFilterReasons(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ dependency: 'merge', reason: expect.stringContaining('Enqueue failed') })
    ]));
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 1);
  });

  test('fails when GitHub does not return a merge queue entry', async () => {
    mockOctokit.rest.repos.getBranchRules.mockResolvedValue({ data: [{ type: 'merge_queue' }] });
    mockOctokit.graphql.mockResolvedValue({ enqueuePullRequest: { mergeQueueEntry: null } });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('did not return a merge queue entry'));
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 0);
  });

  test('skips update-branch-before-merge on the queue path', async () => {
    setup({ 'update-branch-before-merge': 'true' });
    mockOctokit.rest.pulls.get.mockImplementation(({ pull_number }) =>
      Promise.resolve({ data: prDetails(pull_number, { mergeable_state: 'behind' }) }));
    mockOctokit.rest.repos.getBranchRules.mockResolvedValue({ data: [{ type: 'merge_queue' }] });
    mockOctokit.graphql.mockResolvedValue(enqueueResponse());

    await run();

    expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
    expect(mockOctokit.graphql).not.toHaveBeenCalledWith(expect.stringContaining('updatePullRequestBranch'), expect.anything());
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 2);
  });

  test('merge-queue: false disables detection', async () => {
    setup({ 'merge-queue': 'false' });

    await run();

    expect(mockOctokit.rest.repos.getBranchRules).not.toHaveBeenCalled();
    expect(mockOctokit.graphql).not.toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.merge).toHaveBeenCalledTimes(2);
  });

  test('merge-queue: true forces enqueue without detection', async () => {
    setup({ 'merge-queue': 'true' });
    mockOctokit.graphql.mockResolvedValue(enqueueResponse());

    await run();

    expect(mockOctokit.rest.repos.getBranchRules).not.toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.merge).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 2);
  });

  test('invalid merge-queue input fails the action', async () => {
    setup({ 'merge-queue': 'sometimes' });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Invalid merge-queue value 'sometimes'"));
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 0);
  });

  test('treats an already queued PR as queued', async () => {
    mockOctokit.rest.repos.getBranchRules.mockResolvedValue({ data: [{ type: 'merge_queue' }] });
    mockOctokit.graphql.mockRejectedValue(new Error('Pull request is already in the merge queue'));

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('queued-pr-count', 2);
  });
});

describe('merge queue helpers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('parseMergeQueueMode', () => {
    expect(parseMergeQueueMode('')).toBe('auto');
    expect(parseMergeQueueMode(undefined)).toBe('auto');
    expect(parseMergeQueueMode(' TRUE ')).toBe('true');
    expect(parseMergeQueueMode('false')).toBe('false');
    expect(() => parseMergeQueueMode('yes')).toThrow('Invalid merge-queue value');
  });

  test('branchHasMergeQueue caches per branch and falls back on errors', async () => {
    const octokit = { rest: { repos: { getBranchRules: jest.fn() } } };
    octokit.rest.repos.getBranchRules
      .mockResolvedValueOnce({ data: [{ type: 'merge_queue' }] })
      .mockRejectedValueOnce(new Error('Not Found'));
    const cache = new Map();

    expect(await branchHasMergeQueue(octokit, 'o', 'r', 'main', cache)).toBe(true);
    expect(await branchHasMergeQueue(octokit, 'o', 'r', 'main', cache)).toBe(true);
    expect(await branchHasMergeQueue(octokit, 'o', 'r', 'develop', cache)).toBe(false);
    expect(octokit.rest.repos.getBranchRules).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Could not detect merge queue for branch 'develop'"));
  });

  test('enqueuePullRequest requires a node ID', async () => {
    await expect(enqueuePullRequest({ graphql: jest.fn() }, { head: { sha: 'x' } })).rejects.toThrow('Missing PR node ID');
  });
});
