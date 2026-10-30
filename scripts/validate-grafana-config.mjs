import { parser as logqlParser } from '@grafana/lezer-logql';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const jsonRoots = ['alert-rules', 'dashboards', 'notification-policies'];
const errors = [];
const alertUids = new Map();
let checked = 0;
let logqlExpressions = 0;

async function jsonFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error?.code === 'ENOENT') return [];
        throw error;
    });
    const files = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await jsonFiles(path)));
        else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
    }
    return files;
}

function collectExpressions(value, path = '$', expressions = []) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectExpressions(item, `${path}[${index}]`, expressions));
        return expressions;
    }
    if (!value || typeof value !== 'object') return expressions;

    for (const [key, item] of Object.entries(value)) {
        const itemPath = `${path}.${key}`;
        if (key === 'expr' && typeof item === 'string') expressions.push({ path: itemPath, query: item });
        collectExpressions(item, itemPath, expressions);
    }
    return expressions;
}

function normalizeGrafanaMacros(query) {
    return query.replaceAll('$__rate_interval', '5m').replaceAll('$__interval', '5m');
}

function queryFragment(query, from, to) {
    const context = 30;
    const start = Math.max(0, from - context);
    const end = Math.min(query.length, Math.max(to, from + 1) + context);
    return query.slice(start, end);
}

function validateLogql(displayPath, document) {
    for (const expression of collectExpressions(document)) {
        logqlExpressions += 1;
        const query = normalizeGrafanaMacros(expression.query);
        logqlParser.parse(query).iterate({
            enter(node) {
                if (!node.type.isError) return;
                const fragment = queryFragment(query, node.from, node.to);
                errors.push(
                    `${displayPath} ${expression.path}: invalid LogQL at ${node.from}-${node.to} near ${JSON.stringify(fragment)}`,
                );
            },
        });
    }
}

for (const directory of jsonRoots) {
    for (const path of await jsonFiles(join(root, directory))) {
        const displayPath = relative(root, path);
        let document;
        try {
            document = JSON.parse(await readFile(path, 'utf8'));
            checked += 1;
        } catch (error) {
            errors.push(`${displayPath}: invalid JSON (${error.message})`);
            continue;
        }

        if (directory === 'alert-rules' || directory === 'dashboards') {
            validateLogql(displayPath, document);
        }

        if (directory !== 'alert-rules') continue;
        const uid = document?.uid;
        if (typeof uid !== 'string' || uid.length === 0) {
            errors.push(`${displayPath}: missing non-empty top-level uid`);
            continue;
        }
        if (uid.length > 40) errors.push(`${displayPath}: alert uid is ${uid.length} characters; Grafana allows 40`);
        if (!/^[A-Za-z0-9_-]+$/.test(uid)) {
            errors.push(`${displayPath}: alert uid contains unsupported characters`);
        }
        if (!['tokens-critical', 'tokens-slack'].includes(document?.notification_settings?.receiver)) {
            errors.push(`${displayPath}: notification_settings.receiver must be tokens-critical or tokens-slack`);
        }
        const previous = alertUids.get(uid);
        if (previous) errors.push(`${displayPath}: alert uid duplicates ${previous}`);
        else alertUids.set(uid, displayPath);
    }
}

if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exit(1);
}

console.log(
    `Validated ${checked} Grafana JSON files (${alertUids.size} alert UIDs, ${logqlExpressions} LogQL expressions).`,
);
