/**
 * Set, clear, or show a project's API rate-limit override.
 *
 * Usage (run under doppler for the usage-service URL + bearer token):
 *   doppler run --project tokens --config prd_cloudrun -- \
 *     bun scripts/set-project-rate-limit.mjs "<project name or id>" <requests> [windowSeconds]
 *   doppler run --project tokens --config prd_cloudrun -- \
 *     bun scripts/set-project-rate-limit.mjs "<project name or id>" --clear
 *
 * Changes take effect within ~60s (API auth cache TTL). Projects without an
 * override use the code default (TOKENS_DEFAULT_RATE_LIMIT_REQUESTS).
 */

import { callCloudRun } from './_cloudrun.mjs';

function usage(message) {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: set-project-rate-limit.mjs <project name|id> <requests> [windowSeconds]');
    console.error('       set-project-rate-limit.mjs <project name|id> --clear');
    process.exit(1);
}

const [target, requestsArg, windowArg] = process.argv.slice(2);
if (!target || !requestsArg) usage();

async function resolveProject(nameOrId) {
    const projects = await callCloudRun('usage', 'query', 'listProjectsDigest', {});
    const byId = projects.find(p => p.id === nameOrId);
    if (byId) return byId;
    const byName = projects.filter(p => p.name.toLowerCase() === nameOrId.toLowerCase());
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) usage(`"${nameOrId}" matches ${byName.length} projects — use the project id`);
    usage(`no project named or id'd "${nameOrId}"`);
}

const project = await resolveProject(target);

const args = { projectId: project.id };
if (requestsArg === '--clear') {
    args.clear = true;
} else {
    args.requests = Number(requestsArg);
    if (windowArg !== undefined) args.windowSeconds = Number(windowArg);
}

const updated = await callCloudRun('usage', 'mutation', 'projectsSetRateLimit', args);
console.log(`${updated.name} (${updated.id})`);
console.log(`limits: ${JSON.stringify(updated.limits)}`);
console.log('takes effect within ~60s (auth cache TTL)');
