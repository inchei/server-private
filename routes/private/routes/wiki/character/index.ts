import type { Static } from 'typebox';
import t from 'typebox';

import { db, op, schema } from '@app/drizzle';
import { NotFoundError } from '@app/lib/error.ts';
import { Security, Tag } from '@app/lib/openapi/index.ts';
import type { CharacterPersonRev, CharacterSubjectRev } from '@app/lib/orm/entity/index.ts';
import { RevType } from '@app/lib/orm/entity/index.ts';
import * as entity from '@app/lib/orm/entity/index.ts';
import { createRelationHistoryRoute, RelationHistorySummary } from '@app/lib/rev/index.ts';
import * as fetcher from '@app/lib/types/fetcher.ts';
import * as res from '@app/lib/types/res.ts';
import { formatErrors } from '@app/lib/types/res.ts';
import type { App } from '@app/routes/type.ts';

type ICharacterSubjectRelationWiki = Static<typeof CharacterSubjectRelationWiki>;
export const CharacterSubjectRelationWiki = t.Array(
  t.Object({
    subjectName: t.String(),
    subjectId: t.Integer(),
    characterType: t.Integer(),
  }),
  {
    $id: 'CharacterSubjectRelationWiki',
  },
);

type ICharacterPersonRelationWiki = Static<typeof CharacterPersonRelationWiki>;
export const CharacterPersonRelationWiki = t.Array(
  t.Object({
    subjectName: t.String(),
    subjectId: t.Integer(),
    personName: t.String(),
    personId: t.Integer(),
  }),
  {
    $id: 'CharacterPersonRelationWiki',
  },
);

// eslint-disable-next-line @typescript-eslint/require-await
export async function setup(app: App) {
  app.addSchema(RelationHistorySummary);
  app.addSchema(CharacterSubjectRelationWiki);
  app.addSchema(CharacterPersonRelationWiki);

  const characterSubjectHistorySummary = createRelationHistoryRoute(
    'CharacterSubjectHistorySummary',
    '获取角色-条目关联历史编辑摘要',
    'characterID',
    [RevType.characterSubjectRelation],
  );
  app.get(
    '/characters/:characterID/subjects/history-summary',
    {
      schema: characterSubjectHistorySummary.schema,
    },
    characterSubjectHistorySummary.handler,
  );

  app.get(
    '/characters/subjects/revisions/:revisionID',
    {
      schema: {
        tags: [Tag.Wiki],
        operationId: 'getCharacterSubjectRevision',
        summary: '获取角色-条目关联历史版本 wiki 信息',
        params: t.Object({
          revisionID: t.Integer({ minimum: 1 }),
        }),
        security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
        response: {
          200: res.Ref(CharacterSubjectRelationWiki),
          404: res.Ref(res.Error, {
            'x-examples': formatErrors(new NotFoundError('revision')),
          }),
        },
      },
    },
    async ({ params: { revisionID } }): Promise<ICharacterSubjectRelationWiki> => {
      const [r] = await db
        .select()
        .from(schema.chiiRevHistory)
        .where(op.eq(schema.chiiRevHistory.revId, revisionID))
        .limit(1);
      if (!r) {
        throw new NotFoundError(`revision ${revisionID}`);
      }

      const [revText] = await db
        .select()
        .from(schema.chiiRevText)
        .where(op.eq(schema.chiiRevText.revTextId, r.revTextId));
      if (!revText) {
        throw new NotFoundError(`RevText ${r.revTextId}`);
      }

      const revRecord = await entity.RevText.deserialize(revText.revText);

      const revContent = revRecord[revisionID] as CharacterSubjectRev;

      const subjects = await fetcher.fetchSlimSubjectsByIDs(
        Object.values(revContent).map(({ subject_id: id }) => +id),
      );

      const relatedData = Object.values(revContent).map(
        ({ subject_id: subjectId, crt_type: characterType }) => {
          return {
            subjectId: +subjectId,
            subjectName: subjects[+subjectId]?.name || '',
            characterType: +characterType,
          };
        },
      );

      return relatedData;
    },
  );

  const characterPersonHistorySummary = createRelationHistoryRoute(
    'personCastHistorySummary',
    '获取角色-人物关联历史编辑摘要',
    'characterID',
    [RevType.characterCastRelation],
  );
  app.get(
    '/characters/:characterID/persons/history-summary',
    {
      schema: characterPersonHistorySummary.schema,
    },
    characterPersonHistorySummary.handler,
  );

  app.get(
    '/characters/persons/revisions/:revisionID',
    {
      schema: {
        tags: [Tag.Wiki],
        operationId: 'getCharacterPersonRevision',
        summary: '获取角色-人物关联历史版本 wiki 信息',
        params: t.Object({
          revisionID: t.Integer({ minimum: 1 }),
        }),
        security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
        response: {
          200: res.Ref(CharacterPersonRelationWiki),
          404: res.Ref(res.Error, {
            'x-examples': formatErrors(new NotFoundError('revision')),
          }),
        },
      },
    },
    async ({ params: { revisionID } }): Promise<ICharacterPersonRelationWiki> => {
      const [r] = await db
        .select()
        .from(schema.chiiRevHistory)
        .where(op.eq(schema.chiiRevHistory.revId, revisionID))
        .limit(1);
      if (!r) {
        throw new NotFoundError(`revision ${revisionID}`);
      }

      const [revText] = await db
        .select()
        .from(schema.chiiRevText)
        .where(op.eq(schema.chiiRevText.revTextId, r.revTextId));
      if (!revText) {
        throw new NotFoundError(`RevText ${r.revTextId}`);
      }

      const revRecord = await entity.RevText.deserialize(revText.revText);

      const revContent = revRecord[revisionID] as CharacterPersonRev;

      const subjects = await fetcher.fetchSlimSubjectsByIDs(
        Object.values(revContent).map(({ subject_id: id }) => +id),
      );
      const persons = await fetcher.fetchSlimPersonsByIDs(
        Object.values(revContent).map(({ prsn_id: id }) => +id),
      );

      const relatedData = Object.values(revContent).map(
        ({ subject_id: subjectId, prsn_id: personId }) => {
          return {
            subjectId: +subjectId,
            subjectName: subjects[+subjectId]?.name || '',
            personId: +personId,
            personName: persons[+personId]?.name || '',
          };
        },
      );

      return relatedData;
    },
  );
}
