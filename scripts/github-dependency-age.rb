#!/usr/bin/env ruby
# Check upstream publication dates for new GitHub Actions and pre-commit refs.

require 'json'
require 'net/http'
require 'open3'
require 'set'
require 'time'
require 'uri'
require 'yaml'

module GitHubDependencyAge
  SECONDS_PER_DAY = 86_400
  SHA = /\A[0-9a-f]{40}\z/i
  REPOSITORY = %r{[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+}
  WORKFLOW = %r{\A\.github/workflows/[^/]+\.ya?ml\z}
  ACTION = %r{(?:\A|/)action\.ya?ml\z}
  HOOKS = '.pre-commit-config.yaml'.freeze

  def self.action_dependencies(steps)
    steps.map do |step|
      uses = step['uses']
      next unless uses
      next if uses.start_with?('./', '$/')

      source, separator, ref = uses.partition('@')
      match = source.match(%r{\A(#{REPOSITORY})(?:/[^@]+)?\z})
      if match && !separator.empty? && !ref.empty?
        [match[1].downcase, ref]
      else
        [nil, "GitHub Actions source #{uses.inspect}"]
      end
    end.compact
  end

  def self.hook_dependencies(repositories)
    repositories.map do |entry|
      source = entry.fetch('repo')
      next if %w[local meta].include?(source)

      match = source.match(%r{\Ahttps://github\.com/(#{REPOSITORY})/?\z}i)
      ref = entry['rev']
      if match && ref.is_a?(String) && !ref.empty?
        [match[1].downcase.delete_suffix('.git'), ref]
      else
        [nil, "pre-commit source #{source.inspect} at #{ref.inspect}"]
      end
    end.compact
  end

  def self.git_read(*args)
    output, errors, status = Open3.capture3('git', *args)
    raise ArgumentError, "git #{args.first} failed: #{errors.strip}" unless status.success?

    output
  end

  def self.dependencies(commit)
    paths = git_read('ls-tree', '--full-tree', '-r', '-z', '--name-only', commit).split("\0")
    configs = paths.select { |path| path == HOOKS || WORKFLOW.match?(path) || ACTION.match?(path) }
    configs.flat_map do |path|
      yaml = YAML.safe_load(git_read('show', "#{commit}:#{path}"), aliases: true, filename: path)
      if path == HOOKS
        hook_dependencies(yaml.fetch('repos'))
      elsif WORKFLOW.match?(path)
        jobs = yaml.fetch('jobs').values
        action_dependencies(jobs + jobs.flat_map { |job| job.fetch('steps', []) })
      else
        action_dependencies(yaml.fetch('runs').fetch('steps', []))
      end
    end.to_set
  end

  def self.minimum_age(commit)
    days = git_read('show', "#{commit}:.npmrc").scan(/^[ \t]*min-release-age[ \t]*=[ \t]*(\d+)[ \t]*$/).flatten
    raise ArgumentError, '.npmrc must set one positive min-release-age in days' unless days.size == 1 && days.first.to_i > 0

    days.first.to_i * SECONDS_PER_DAY
  end

  class Publications
    def initialize(token)
      @token = token
    end

    def published_at(repository, revision)
      unless repository.match?(%r{\A#{REPOSITORY}\z}) && !%w[. ..].include?(repository.split('/').last) &&
             revision.is_a?(String) && !revision.empty?
        raise ArgumentError, 'expected a GitHub repository and a release tag or full commit SHA'
      end

      path = "/repos/#{repository}"
      pinned = SHA.match?(revision)
      if pinned
        sha = revision.downcase
        dates = []
      else
        sha, dates = tag_target(path, revision)
        dates << release_date(path, revision)
      end

      commit = get("#{path}/git/commits/#{sha}")
      raise ArgumentError, 'GitHub returned the wrong commit' unless commit.fetch('sha') == sha

      # Moving major/minor tags and full SHA pins can have separately published releases.
      if pinned || revision.match?(/\Av?\d+(?:\.\d+)?\z/)
        get("#{path}/tags?per_page=100").each do |tag|
          name = tag.fetch('name')
          next if name == revision || tag.fetch('commit').fetch('sha') != sha
          next unless pinned || name.start_with?("#{revision}.")

          dates << release_date(path, name)
        end
      end

      dates.compact!
      if !pinned && dates.empty?
        raise ArgumentError, 'lightweight tag has no matching published release; pin an eligible full commit SHA'
      end

      # A mutable tag is checked at the target GitHub returns during CI.
      dates << timestamp(commit.fetch('committer').fetch('date'))
      dates.max
    end

    private

    def tag_target(path, name)
      ref = get("#{path}/git/ref/tags/#{encode(name)}", allow_missing: true)
      raise ArgumentError, 'no GitHub release tag found for this revision' unless ref
      raise ArgumentError, 'GitHub returned the wrong tag' unless ref.fetch('ref') == "refs/tags/#{name}"

      dated_tags = []
      seen = Set.new
      object = ref.fetch('object')
      loop do
        sha = object.fetch('sha')
        raise ArgumentError, 'GitHub returned an invalid Git object' unless SHA.match?(sha) && seen.add?(sha)

        case object.fetch('type')
        when 'commit'
          return [sha, dated_tags]
        when 'tag'
          tag = get("#{path}/git/tags/#{sha}")
          raise ArgumentError, 'GitHub returned the wrong annotated tag' unless tag.fetch('sha') == sha

          dated_tags << timestamp(tag.fetch('tagger').fetch('date'))
          object = tag.fetch('object')
        else
          raise ArgumentError, 'GitHub release tag does not refer to a commit'
        end
      end
    end

    def release_date(path, name)
      release = get("#{path}/releases/tags/#{encode(name)}", allow_missing: true)
      return if !release || release['draft']
      raise ArgumentError, 'GitHub returned the wrong release' unless release.fetch('tag_name') == name

      timestamp(release.fetch('published_at'))
    end

    def timestamp(value)
      DateTime.rfc3339(value).to_time
    end

    def encode(value)
      URI.encode_www_form_component(value).gsub('+', '%20')
    end

    def get(path, allow_missing: false)
      uri = URI("https://api.github.com#{path}")
      request = Net::HTTP::Get.new(uri)
      request['Accept'] = 'application/vnd.github+json'
      request['X-GitHub-Api-Version'] = '2022-11-28'
      request['Authorization'] = "Bearer #{@token}" unless @token.to_s.empty?
      response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 10, read_timeout: 20) do |http|
        http.request(request)
      end
      return nil if allow_missing && response.is_a?(Net::HTTPNotFound)

      raise ArgumentError, "GitHub API returned HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)

      JSON.parse(response.body)
    end
  end

  def self.check(dependencies, publications:, cutoff:)
    dependencies.sort_by { |repo, ref| [repo.to_s, ref] }.map do |repo, ref|
      next "#{ref} has no verifiable age (expected a GitHub repository and a release tag or full commit SHA)" unless repo

      begin
        published_at = publications.published_at(repo, ref)
        if published_at > cutoff
          "#{repo.inspect}@#{ref.inspect} became available #{published_at.utc.iso8601}, after cutoff #{cutoff.utc.iso8601}"
        end
      rescue ArgumentError, KeyError, TypeError, JSON::ParserError, IOError, SocketError, Timeout::Error,
             SystemCallError, OpenSSL::SSL::SSLError => error
        "#{repo.inspect}@#{ref.inspect} has no verifiable age (#{error.message})"
      end
    end.compact
  end

  def self.main(base, candidate = nil)
    unless SHA.match?(base.to_s) && (candidate.nil? || SHA.match?(candidate))
      raise ArgumentError, 'usage: ruby scripts/github-dependency-age.rb BASE_COMMIT_SHA [CANDIDATE_COMMIT_SHA]'
    end

    candidate ||= 'HEAD'
    added = dependencies(candidate) - dependencies(base)
    if added.empty?
      puts 'No new GitHub Actions or pre-commit dependency refs.'
      return 0
    end

    cutoff = Time.now.utc - minimum_age(candidate)
    problems = check(added, publications: Publications.new(ENV['GITHUB_TOKEN']), cutoff: cutoff)
    problems.each { |problem| warn problem }
    return 1 unless problems.empty?

    puts "Verified release age for #{added.size} new GitHub Actions or pre-commit dependency refs."
    0
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    exit GitHubDependencyAge.main(*ARGV)
  rescue ArgumentError, KeyError, NoMethodError, Psych::Exception => error
    abort "GitHub dependency release age check failed: #{error.message}"
  end
end
