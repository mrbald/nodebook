require 'fileutils'
require 'minitest/autorun'
require 'tmpdir'
require_relative 'github-dependency-age'

class GitHubDependencyAgeTest < Minitest::Test
  POLICY = GitHubDependencyAge
  REPOSITORY = 'example/action'.freeze
  ROOT = "/repos/#{REPOSITORY}".freeze
  COMMIT = ('a' * 40).freeze
  TAG = ('b' * 40).freeze
  OLD = '2026-11-01T00:00:00Z'.freeze
  CUTOFF = '2026-11-15T00:00:00Z'.freeze
  RECENT = '2026-11-18T00:00:00Z'.freeze

  class StubPublications < GitHubDependencyAge::Publications
    def initialize(responses)
      @responses = responses
    end

    def get(path, allow_missing: false)
      return nil if allow_missing && !@responses.key?(path)

      @responses.fetch(path)
    end
  end

  def test_compares_actual_workflow_and_hook_dependencies_as_unique_refs
    Dir.mktmpdir do |directory|
      Dir.chdir(directory) do
        POLICY.git_read('init', '--quiet')
        base = commit({
          '.github/workflows/test.yml' => workflow('Example/Action@v1.0.0'),
          '.pre-commit-config.yaml' => hooks('https://github.com/example/linter.git', 'v1.1.0')
        })
        candidate = commit({
          '.github/workflows/test.yml' => workflow('example/action@v1.1.0'),
          '.github/actions/composite/action.yml' => <<~YAML,
            runs:
              using: composite
              steps:
                - uses: example/action/path@v1.1.0
                - uses: example/composite@v2.0.0
          YAML
          '.pre-commit-config.yaml' => hooks('https://github.com/example/linter/', 'v1.1.0')
        })

        assert_equal Set[['example/action', 'v1.1.0'], ['example/composite', 'v2.0.0']],
                     POLICY.dependencies(candidate) - POLICY.dependencies(base)
      end
    end
  end

  def test_rejects_an_unverifiable_source_without_querying_github
    dependencies = POLICY.hook_dependencies([{ 'repo' => 'example/action', 'rev' => 'v1.0.0' }])
    problems = POLICY.check(dependencies, publications: StubPublications.new({}), cutoff: Time.iso8601(CUTOFF))
    assert_equal 1, problems.size
    assert_match(/pre-commit source.*has no verifiable age/, problems.first)
  end

  def test_uses_release_publication_to_age_an_old_commit
    responses = commit_response.merge(tag_response('v1.0.0'), release_response('v1.0.0', RECENT))
    problems = check('v1.0.0', responses)
    assert_equal 1, problems.size
    assert_includes problems.first, "became available #{RECENT}"
  end

  def test_accepts_an_annotated_tag_at_the_cutoff_without_a_github_release
    responses = commit_response.merge(
      tag_response('v1.0.0', type: 'tag', sha: TAG),
      "#{ROOT}/git/tags/#{TAG}" => {
        'sha' => TAG, 'tagger' => { 'date' => CUTOFF }, 'object' => { 'type' => 'commit', 'sha' => COMMIT }
      }
    )
    assert_empty check('v1.0.0', responses)
  end

  def test_uses_publication_time_of_the_current_target_of_a_moving_tag
    responses = commit_response.merge(
      tag_response('v1'),
      release_response('v1.2.0', RECENT),
      "#{ROOT}/tags?per_page=100" => [
        { 'name' => 'v1.2.0', 'commit' => { 'sha' => COMMIT } },
        { 'name' => 'v1.2.1', 'commit' => { 'sha' => ('c' * 40) } }
      ]
    )
    assert_includes check('v1', responses).first, "became available #{RECENT}"
  end

  def test_rejects_an_unpublished_branch
    assert_includes check('main', {}).first, 'no GitHub release tag found for this revision'
  end

  def test_rejects_an_unpublished_lightweight_tag_even_at_an_old_commit
    responses = commit_response.merge(tag_response('v1.0.0'))
    assert_includes check('v1.0.0', responses).first, 'lightweight tag has no matching published release'
  end

  def test_uses_commit_age_for_an_explicit_sha_without_a_published_release
    responses = commit_response.merge("#{ROOT}/tags?per_page=100" => [])
    assert_empty check(COMMIT, responses)
  end

  private

  def workflow(uses)
    <<~YAML
      jobs:
        test:
          steps:
            - uses: #{uses}
            - uses: ./.github/actions/composite
            - run: echo unrelated input
              env:
                uses: ignore/this@v1
        reuse:
          uses: example/reusable/.github/workflows/test.yml@v2.0.0
    YAML
  end

  def hooks(repo, rev)
    <<~YAML
      repos:
        - repo: #{repo}
          rev: #{rev}
          hooks: [{id: lint}]
        - repo: local
          hooks: [{id: local}]
        - repo: meta
          hooks: [{id: identity}]
    YAML
  end

  def commit(files)
    files.each do |path, contents|
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, contents)
    end
    POLICY.git_read('add', '--', *files.keys)
    POLICY.git_read('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
                    'commit', '--quiet', '-m', 'test fixture')
    POLICY.git_read('rev-parse', 'HEAD').strip
  end

  def commit_response
    { "#{ROOT}/git/commits/#{COMMIT}" => { 'sha' => COMMIT, 'committer' => { 'date' => OLD } } }
  end

  def tag_response(name, type: 'commit', sha: COMMIT)
    { "#{ROOT}/git/ref/tags/#{name}" => { 'ref' => "refs/tags/#{name}", 'object' => { 'type' => type, 'sha' => sha } } }
  end

  def release_response(name, date)
    { "#{ROOT}/releases/tags/#{name}" => { 'tag_name' => name, 'published_at' => date } }
  end

  def check(revision, responses)
    POLICY.check([[REPOSITORY, revision]], publications: StubPublications.new(responses), cutoff: Time.iso8601(CUTOFF))
  end
end
