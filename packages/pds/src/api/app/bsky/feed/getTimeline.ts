import { sql } from 'kysely'
import { InvalidRequestError } from '@atproto/xrpc-server'
import { Server } from '../../../../lexicon'
import { isEnum } from '../util'
import {
  FeedAlgorithm,
  FeedItemType,
  FeedKeyset,
  composeFeed,
} from '../util/feed'
import { countAll } from '../../../../db/util'
import { paginate } from '../../../../db/pagination'
import AppContext from '../../../../context'

export default function (server: Server, ctx: AppContext) {
  server.app.bsky.feed.getTimeline({
    auth: ctx.accessVerifier,
    handler: async ({ params, auth }) => {
      const { algorithm, limit, before } = params
      const db = ctx.db.db
      const { ref } = db.dynamic
      const requester = auth.credentials.did

      let feedAlgorithm: FeedAlgorithm
      if (isEnum(FeedAlgorithm, algorithm)) {
        feedAlgorithm = algorithm
      } else if (algorithm === undefined) {
        feedAlgorithm = FeedAlgorithm.ReverseChronological
      } else {
        throw new InvalidRequestError(`Unsupported algorithm: ${algorithm}`)
      }

      let postsQb = db
        .selectFrom('post')
        .select([
          sql<FeedItemType>`${'post'}`.as('type'),
          'uri as postUri',
          'cid as postCid',
          'creator as originatorDid',
          'indexedAt as cursor',
        ])

      let repostsQb = db
        .selectFrom('repost')
        .select([
          sql<FeedItemType>`${'repost'}`.as('type'),
          'subject as postUri',
          'subjectCid as postCid',
          'creator as originatorDid',
          'indexedAt as cursor',
        ])

      let trendsQb = db
        .selectFrom('trend')
        .select([
          sql<FeedItemType>`${'trend'}`.as('type'),
          'subject as postUri',
          'subjectCid as postCid',
          'creator as originatorDid',
          'indexedAt as cursor',
        ])

      if (feedAlgorithm === FeedAlgorithm.Firehose) {
        // All posts
      } else if (feedAlgorithm === FeedAlgorithm.ReverseChronological) {
        // Followee's posts/reposts/trends, and requester's posts
        const followingIdsSubquery = db
          .selectFrom('follow')
          .select('follow.subjectDid')
          .where('follow.creator', '=', requester)
        repostsQb = repostsQb
          .where('creator', '=', requester)
          .orWhere('creator', 'in', followingIdsSubquery)
        trendsQb = trendsQb
          .where('creator', '=', requester)
          .orWhere('creator', 'in', followingIdsSubquery)
        postsQb = postsQb
          .where('creator', '=', requester)
          .orWhere('creator', 'in', followingIdsSubquery)
      } else {
        const exhaustiveCheck: never = feedAlgorithm
        throw new Error(`Unhandled case: ${exhaustiveCheck}`)
      }

      let feedItemsQb = db
        .selectFrom(postsQb.union(repostsQb).union(trendsQb).as('feed_items'))
        .innerJoin('post', 'post.uri', 'postUri')
        .innerJoin('ipld_block', 'ipld_block.cid', 'post.cid')
        .innerJoin('did_handle as author', 'author.did', 'post.creator')
        .leftJoin(
          'profile as author_profile',
          'author_profile.creator',
          'author.did',
        )
        .innerJoin(
          'did_handle as originator',
          'originator.did',
          'originatorDid',
        )
        .leftJoin(
          'profile as originator_profile',
          'originator_profile.creator',
          'originatorDid',
        )
        .select([
          'type',
          'postUri',
          'postCid',
          'cursor',
          'ipld_block.content as recordBytes',
          'ipld_block.indexedAt as indexedAt',
          'author.did as authorDid',
          'author.declarationCid as authorDeclarationCid',
          'author.actorType as authorActorType',
          'author.handle as authorHandle',
          'author.actorType as authorActorType',
          'author_profile.displayName as authorDisplayName',
          'author_profile.avatarCid as authorAvatarCid',
          'originator.did as originatorDid',
          'originator.declarationCid as originatorDeclarationCid',
          'originator.actorType as originatorActorType',
          'originator.handle as originatorHandle',
          'originator.actorType as originatorActorType',
          'originator_profile.displayName as originatorDisplayName',
          'originator_profile.avatarCid as originatorAvatarCid',
          db
            .selectFrom('vote')
            .whereRef('subject', '=', ref('postUri'))
            .where('direction', '=', 'up')
            .select(countAll.as('count'))
            .as('upvoteCount'),
          db
            .selectFrom('vote')
            .whereRef('subject', '=', ref('postUri'))
            .where('direction', '=', 'down')
            .select(countAll.as('count'))
            .as('downvoteCount'),
          db
            .selectFrom('repost')
            .whereRef('subject', '=', ref('postUri'))
            .select(countAll.as('count'))
            .as('repostCount'),
          db
            .selectFrom('post')
            .whereRef('replyParent', '=', ref('postUri'))
            .select(countAll.as('count'))
            .as('replyCount'),
          db
            .selectFrom('repost')
            .where('creator', '=', requester)
            .whereRef('subject', '=', ref('postUri'))
            .select('uri')
            .as('requesterRepost'),
          db
            .selectFrom('vote')
            .where('creator', '=', requester)
            .whereRef('subject', '=', ref('postUri'))
            .where('direction', '=', 'up')
            .select('uri')
            .as('requesterUpvote'),
          db
            .selectFrom('vote')
            .where('creator', '=', requester)
            .whereRef('subject', '=', ref('postUri'))
            .where('direction', '=', 'down')
            .select('uri')
            .as('requesterDownvote'),
        ])

      const keyset = new FeedKeyset(ref('cursor'), ref('postCid'))
      feedItemsQb = paginate(feedItemsQb, {
        limit,
        before,
        keyset,
      })

      const queryRes = await feedItemsQb.execute()
      const feed = await composeFeed(db, ctx.imgUriBuilder, queryRes)

      return {
        encoding: 'application/json',
        body: {
          feed,
          cursor: keyset.packFromResult(queryRes),
        },
      }
    },
  })
}
