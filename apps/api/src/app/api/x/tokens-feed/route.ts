import { Effect } from 'effect';

import { fetchJsonWithRetry, tapErrorAndDefault } from '@tokens/effect';
import { route } from '@/effect/next-route';
import { resolveXBearerToken, runXRequest } from '@/lib/x-auth';
import { restoreXCashtagsInTexts } from '@/lib/x-cashtags';
import { buildMediaByKey, getPostImage, type XMedia, type XPostMediaAttachment } from '@/lib/x-media';

interface NewsFeedArticle {
    title: string;
    url: string;
    image: string;
    author: string;
    posted_at: string;
    type: 'news';
    source_name: string;
    related_coin_ids: string[];
}

interface XUser {
    id: string;
    name: string;
    username: string;
    profile_image_url?: string;
}

interface XUserLookupResponse {
    data?: XUser;
}

interface XPost {
    id: string;
    text: string;
    created_at?: string;
    attachments?: XPostMediaAttachment;
    in_reply_to_user_id?: string;
    referenced_tweets?: { type: string; id: string }[];
}

// The X API's `exclude=replies` param is not always honored, so filter defensively:
// replies don't read as cleanly as standalone posts in the feed.
function isReplyPost(post: XPost): boolean {
    if (post.in_reply_to_user_id) return true;
    return post.referenced_tweets?.some(reference => reference.type === 'replied_to') ?? false;
}

interface XUserPostsResponse {
    data?: XPost[];
    includes?: {
        media?: XMedia[];
    };
}

const X_USERNAME = 'tokens';
const DEFAULT_POST_LIMIT = 10;
const MIN_X_RESULTS = 5;
const MAX_X_RESULTS = 20;

function parseLimit(value: string | null): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POST_LIMIT;
    return Math.min(Math.max(parsed, MIN_X_RESULTS), MAX_X_RESULTS);
}

function cleanPostText(value: string): string {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function buildXPostUrl(username: string, postId: string): string {
    return `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(postId)}`;
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const requestUrl = new URL(request.url);
            const limit = parseLimit(requestUrl.searchParams.get('limit'));

            const bearerToken = yield* resolveXBearerToken().pipe(
                tapErrorAndDefault('x.tokensFeed.resolveBearerToken', null),
            );
            if (!bearerToken) return [] satisfies NewsFeedArticle[];

            const authHeaders = {
                Accept: 'application/json',
                Authorization: `Bearer ${bearerToken}`,
            };

            const userUrl = new URL(`https://api.x.com/2/users/by/username/${X_USERNAME}`);
            userUrl.searchParams.set('user.fields', 'id,name,username,profile_image_url');

            const userResponse: XUserLookupResponse = yield* runXRequest(
                fetchJsonWithRetry<XUserLookupResponse>({
                    url: userUrl.toString(),
                    service: 'x',
                    init: {
                        headers: authHeaders,
                        next: { revalidate: 60 },
                    },
                    maxRetries: 2,
                }),
            ).pipe(tapErrorAndDefault('x.tokensFeed.userLookup', {} as XUserLookupResponse));

            const user = userResponse.data;
            if (!user?.id) return [] satisfies NewsFeedArticle[];

            const postsUrl = new URL(`https://api.x.com/2/users/${user.id}/tweets`);
            postsUrl.searchParams.set('max_results', String(limit));
            postsUrl.searchParams.set('exclude', 'retweets,replies');
            postsUrl.searchParams.set('tweet.fields', 'attachments,created_at,text,in_reply_to_user_id,referenced_tweets');
            postsUrl.searchParams.set('expansions', 'attachments.media_keys');
            postsUrl.searchParams.set('media.fields', 'media_key,preview_image_url,type,url');

            const postsResponse: XUserPostsResponse = yield* runXRequest(
                fetchJsonWithRetry<XUserPostsResponse>({
                    url: postsUrl.toString(),
                    service: 'x',
                    init: {
                        headers: authHeaders,
                        next: { revalidate: 60 },
                    },
                    maxRetries: 2,
                }),
            ).pipe(tapErrorAndDefault('x.tokensFeed.userPosts', {} as XUserPostsResponse));
            const mediaByKey = buildMediaByKey(postsResponse.includes?.media);

            const posts = (postsResponse.data ?? []).filter(
                post => post.id && post.text && post.created_at && !isReplyPost(post),
            );
            // X's token tags arrive as `solana:<mint>` in the API text; restore them to `$SYMBOL`.
            const titles = yield* restoreXCashtagsInTexts(posts.map(post => cleanPostText(post.text)));

            return posts
                .map((post, index) => ({
                    title: titles[index] ?? cleanPostText(post.text),
                    url: buildXPostUrl(user.username, post.id),
                    image: getPostImage(post, mediaByKey, user.profile_image_url),
                    author: user.username,
                    posted_at: post.created_at ?? '',
                    type: 'news' as const,
                    source_name: `@${user.username}`,
                    related_coin_ids: [],
                }))
                .slice(0, limit) satisfies NewsFeedArticle[];
        }),
    { platform: { requiredScopes: ['assets:read'] } },
);
