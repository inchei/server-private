import t, { type Static } from 'typebox';

import { db, op, schema } from '@app/drizzle';
import { Security, Tag } from '@app/lib/openapi/index.ts';
import { type RevType } from '@app/lib/orm/entity';
import * as fetcher from '@app/lib/types/fetcher.ts';
import * as res from '@app/lib/types/res.ts';
import { ghostUser } from '@app/lib/user/utils.ts';

type RevTypeValue =
  | typeof RevType.subjectRelation
  | typeof RevType.subjectCharacterRelation
  | typeof RevType.subjectCastRelation
  | typeof RevType.subjectPersonRelation
  | typeof RevType.characterSubjectRelation
  | typeof RevType.characterCastRelation
  | typeof RevType.personCastRelation
  | typeof RevType.personSubjectRelation;

export function createRelationHistoryRoute(
  operationId: string,
  summary: string,
  idName: string,
  revTypes: RevTypeValue[],
) {
  const paramsSchema = t.Object({
    [idName]: t.Integer({ minimum: 1 }),
  });
  return {
    schema: {
      tags: [Tag.Wiki],
      operationId,
      summary,
      params: paramsSchema,
      querystring: t.Object({
        limit: t.Optional(
          t.Integer({ default: 20, minimum: 1, maximum: 100, description: 'max 100' }),
        ),
        offset: t.Optional(t.Integer({ default: 0, minimum: 0, description: 'min 0' })),
      }),
      security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
      response: {
        200: res.Paged(res.Ref(res.RelationHistory)),
      },
    },
    handler: async ({
      params,
      query: { limit = 20, offset = 0 },
    }: {
      params: Static<typeof paramsSchema>;
      query: { limit?: number; offset?: number };
    }) => {
      const targetId = params[idName];
      if (typeof targetId !== 'number') {
        throw new TypeError(`${idName} should be a number`);
      }

      const [{ count = 0 } = {}] = await db
        .select({ count: op.countDistinct(schema.chiiRevHistory.revId) })
        .from(schema.chiiRevHistory)
        .where(
          op.and(
            op.eq(schema.chiiRevHistory.revMid, targetId),
            op.inArray(schema.chiiRevHistory.revType, revTypes),
          ),
        );

      const history = await db
        .select()
        .from(schema.chiiRevHistory)
        .where(
          op.and(
            op.eq(schema.chiiRevHistory.revMid, targetId),
            op.inArray(schema.chiiRevHistory.revType, revTypes),
          ),
        )
        .orderBy(op.desc(schema.chiiRevHistory.revId))
        .offset(offset)
        .limit(limit);

      const users = await fetcher.fetchSlimUsersByIDs(history.map((x) => x.revCreator));
      const revisions = history.map(
        (x) =>
          ({
            id: x.revId,
            creator: {
              username: users[x.revCreator]?.username ?? ghostUser(x.revCreator).username,
            },
            createdAt: x.createdAt,
            commitMessage: x.revEditSummary,
          }) satisfies res.IRelationHistory,
      );

      return { total: count, data: revisions };
    },
  };
}
