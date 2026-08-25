#!/usr/bin/env node
// Fetches Dependabot security alerts for every active repository in an
// organisation and writes an aggregated JSON report. Requires the `gh` CLI
// to be authenticated (GH_TOKEN) with a token that has Dependabot alert
// read access across the target organisation.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ORG = process.env.GITHUB_ORG || 'SkillsFundingAgency';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'dependabot-alerts.json';
const INCLUDE_ARCHIVED = process.env.INCLUDE_ARCHIVED === 'true';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

function ghApiLines(path, extraArgs = []) {
  const args = ['api', '-X', 'GET', path, '--paginate', ...extraArgs];
  const result = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
  return result
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function listRepos(org) {
  return ghApiLines(`orgs/${org}/repos`, [
    '-f', 'per_page=100',
    '--jq', '.[] | {name: .name, fullName: .full_name, archived: .archived, disabled: .disabled, htmlUrl: .html_url}'
  ]);
}

function fetchAlerts(fullName) {
  try {
    return ghApiLines(`repos/${fullName}/dependabot/alerts`, [
      '-f', 'per_page=100',
      '--jq', '.[] | {number, state, severity: .security_advisory.severity, summary: .security_advisory.summary, cveId: .security_advisory.cve_id, package: .dependency.package.name, ecosystem: .dependency.package.ecosystem, manifestPath: .dependency.manifest_path, vulnerableVersionRange: .security_vulnerability.vulnerable_version_range, firstPatchedVersion: .security_vulnerability.first_patched_version.identifier, createdAt: .created_at, updatedAt: .updated_at, fixedAt: .fixed_at, dismissedAt: .dismissed_at, htmlUrl: .html_url}'
    ]);
  } catch (error) {
    const message = String(error.stderr ? error.stderr.toString() : error.message || '').trim();
    return { error: message.split('\n')[0] || 'fetch-failed' };
  }
}

function summarize(alerts) {
  const summary = { open: 0, fixed: 0, dismissed: 0, bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) };
  for (const alert of alerts) {
    if (alert.state === 'open') {
      summary.open += 1;
      if (summary.bySeverity[alert.severity] !== undefined) summary.bySeverity[alert.severity] += 1;
    } else if (alert.state === 'fixed') summary.fixed += 1;
    else if (alert.state === 'dismissed') summary.dismissed += 1;
  }
  return summary;
}

function buildReport() {
  const repos = listRepos(ORG).filter((repo) => !repo.disabled && (INCLUDE_ARCHIVED || !repo.archived));
  const repositories = [];
  const totals = { repositories: 0, reposScanned: 0, reposWithOpenAlerts: 0, openAlerts: 0, bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) };

  for (const repo of repos) {
    const result = fetchAlerts(repo.fullName);
    totals.repositories += 1;
    if (Array.isArray(result)) {
      const summary = summarize(result);
      repositories.push({ name: repo.name, url: repo.htmlUrl, archived: repo.archived, alertsAvailable: true, summary, alerts: result });
      totals.reposScanned += 1;
      totals.openAlerts += summary.open;
      if (summary.open > 0) totals.reposWithOpenAlerts += 1;
      for (const severity of SEVERITIES) totals.bySeverity[severity] += summary.bySeverity[severity];
    } else {
      repositories.push({ name: repo.name, url: repo.htmlUrl, archived: repo.archived, alertsAvailable: false, reason: result.error, alerts: [] });
    }
  }

  return {
    organisation: ORG,
    generatedAt: new Date().toISOString(),
    repositories: repositories.sort((a, b) => a.name.localeCompare(b.name)),
    totals
  };
}

const report = buildReport();
writeFileSync(OUTPUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Wrote ${OUTPUT_FILE}: ${report.totals.reposScanned}/${report.totals.repositories} repos scanned, ` +
  `${report.totals.openAlerts} open alerts across ${report.totals.reposWithOpenAlerts} repos.`
);
