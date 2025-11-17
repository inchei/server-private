import type { Static } from 'typebox';
import t from 'typebox';

import { db, op, schema } from '@app/drizzle';
import { NotAllowedError } from '@app/lib/auth/index.ts';
import { LockedError, NotFoundError } from '@app/lib/error.ts';
import { Security, Tag } from '@app/lib/openapi/index.ts';
import type { PersonRev } from '@app/lib/orm/entity/index.ts';
import type { PersonCharacterRev, PersonSubjectRev } from '@app/lib/orm/entity/index.ts';
import { createRevision, RevType } from '@app/lib/orm/entity/index.ts';
import * as entity from '@app/lib/orm/entity/index.ts';
import { AppDataSource, PersonRepo } from '@app/lib/orm/index.ts';
import { createRelationHistoryRoute } from '@app/lib/rev/index.ts';
import { InvalidWikiSyntaxError } from '@app/lib/subject/index.ts';
import * as fetcher from '@app/lib/types/fetcher.ts';
import * as res from '@app/lib/types/res.ts';
import { formatErrors } from '@app/lib/types/res.ts';
import { matchExpected, WikiChangedError } from '@app/lib/wiki.ts';
import { requireLogin } from '@app/routes/hooks/pre-handler.ts';
import type { App } from '@app/routes/type.ts';

export const PersonWikiInfo = t.Object(
  {
    id: t.Integer(),
    name: t.String(),
    typeID: res.Ref(res.SubjectType),
    infobox: t.String(),
    summary: t.String(),
  },
  { $id: 'PersonWikiInfo' },
);

export const PersonEdit = t.Object(
  {
    name: t.String({ minLength: 1 }),
    infobox: t.String({ minLength: 1 }),
    summary: t.String(),
  },
  {
    $id: 'PersonEdit',
    additionalProperties: false,
  },
);

type IPersonSubjectRelationWiki = Static<typeof PersonSubjectRelationWiki>;
export const PersonSubjectRelationWiki = t.Array(
  t.Object({
    subjectName: t.String(),
    subjectId: t.Integer(),
    position: t.Integer(),
  }),
  {
    $id: 'PersonSubjectRelationWiki',
  },
);

type IPersonCharacterRelationWiki = Static<typeof PersonCharacterRelationWiki>;
export const PersonCharacterRelationWiki = t.Array(
  t.Object({
    subjectName: t.String(),
    subjectId: t.Integer(),
    characterName: t.String(),
    characterId: t.Integer(),
  }),
  {
    $id: 'PersonCharacterRelationWiki',
  },
);

// eslint-disable-next-line @typescript-eslint/require-await
export async function setup(app: App) {
  app.addSchema(PersonWikiInfo);
  app.addSchema(PersonSubjectRelationWiki);
  app.addSchema(PersonCharacterRelationWiki);

  app.get(
    '/persons/:personID',
    {
      schema: {
        tags: [Tag.Wiki],
        operationId: 'getPersonWikiInfo',
        description: '获取当前的 wiki 信息',
        params: t.Object({
          personID: t.Integer({ minimum: 1 }),
        }),
        security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
        response: {
          200: res.Ref(PersonWikiInfo),
          401: res.Ref(res.Error, {
            'x-examples': formatErrors(new InvalidWikiSyntaxError()),
          }),
          404: res.Ref(res.Error, {
            description: '角色不存在',
          }),
        },
      },
    },
    async ({ params: { personID } }): Promise<Static<typeof PersonWikiInfo>> => {
      const p = await PersonRepo.findOneBy({ id: personID, redirect: 0 });
      if (!p) {
        throw new NotFoundError(`person ${personID}`);
      }

      if (p.lock) {
        throw new NotAllowedError('edit a locked person');
      }

      return {
        id: p.id,
        name: p.name,
        infobox: p.infobox,
        summary: p.summary,
        typeID: p.type,
      };
    },
  );

  app.patch(
    '/persons/:personID',
    {
      schema: {
        tags: [Tag.Wiki],
        operationId: 'patchPersonInfo',
        params: t.Object({
          personID: t.Integer({ minimum: 1 }),
        }),
        security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
        body: t.Object(
          {
            commitMessage: t.String({ minLength: 1 }),
            expectedRevision: t.Partial(PersonEdit, { default: {}, additionalProperties: false }),
            person: t.Partial(PersonEdit, { additionalProperties: false }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: t.Object({}),
          400: res.Ref(res.Error, {
            'x-examples': formatErrors(
              new WikiChangedError(`Index: name
===================================================================
--- name	expected
+++ name	current
@@ -1,1 +1,1 @@
-1234
+水樹奈々
`),
            ),
          }),
          401: res.Ref(res.Error, {
            'x-examples': formatErrors(new InvalidWikiSyntaxError()),
          }),
        },
      },
      preHandler: [requireLogin('editing a subject info')],
    },
    async ({
      auth,
      body: { commitMessage, person: input, expectedRevision },
      params: { personID },
    }) => {
      if (!auth.permission.mono_edit) {
        throw new NotAllowedError('edit person');
      }

      await AppDataSource.transaction(async (t) => {
        const PersonRepo = t.getRepository(entity.Person);
        const p = await PersonRepo.findOneBy({ id: personID });
        if (!p) {
          throw new NotFoundError(`person ${personID}`);
        }
        if (p.lock || p.redirect) {
          throw new LockedError();
        }

        matchExpected(expectedRevision, { name: p.name, infobox: p.infobox, summary: p.summary });

        p.infobox = input.infobox ?? p.infobox;
        p.name = input.name ?? p.name;
        p.summary = input.summary ?? p.summary;

        await PersonRepo.save(p);

        await createRevision(t, {
          mid: personID,
          type: RevType.personEdit,
          rev: {
            crt_name: p.name,
            crt_infobox: p.infobox,
            crt_summary: p.summary,
            extra: {
              img: p.img,
            },
          } satisfies PersonRev,
          creator: auth.userID,
          comment: commitMessage,
        });
      });

      return {};
    },
  );

  const personSubjectHistorySummary = createRelationHistoryRoute(
    'personSubjectHistorySummary',
    '获取人物-条目关联历史编辑摘要',
    'personID',
    [RevType.personSubjectRelation],
  );
  app.get(
    '/persons/:personID/subjects/history-summary',
    {
      schema: personSubjectHistorySummary.schema,
    },
    personSubjectHistorySummary.handler,
  );

  app.get(
    '/persons/-/subjects/revisions/:revisionID',
    {
      schema: {
        tags: [Tag.Wiki],
        operationId: 'getPersonSubjectRevision',
        summary: '获取人物-条目关联历史版本 wiki 信息',
        params: t.Object({
          revisionID: t.Integer({ minimum: 1 }),
        }),
        security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
        response: {
          200: res.Ref(PersonSubjectRelationWiki),
          404: res.Ref(res.Error, {
            'x-examples': formatErrors(new NotFoundError('revision')),
          }),
        },
      },
    },
    async ({ params: { revisionID } }): Promise<IPersonSubjectRelationWiki> => {
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

      const revContent = revRecord[revisionID] as PersonSubjectRev;

      const subjects = await fetcher.fetchSlimSubjectsByIDs(
        Object.values(revContent).map(({ subject_id: id }) => +id),
      );

      const relatedData = Object.values(revContent).map(({ subject_id: subjectId, position }) => {
        return {
          subjectId: +subjectId,
          subjectName: subjects[+subjectId]?.name || '',
          position: +position,
        };
      });

      return relatedData;
    },
  );

  const personCharacterHistorySummary = createRelationHistoryRoute(
    'personCharacterHistorySummary',
    '获取人物-角色关联历史编辑摘要',
    'personID',
    [RevType.personCastRelation],
  );
  app.get(
    '/persons/:personID/characters/history-summary',
    {
      schema: personCharacterHistorySummary.schema,
    },
    personCharacterHistorySummary.handler,
  );

  app.get(
    '/persons/-/characters/revisions/:revisionID',
    {
      schema: {
        tags: [Tag.Wiki],
        operationId: 'getPersonCharacterRevision',
        summary: '获取人物-角色关联历史版本 wiki 信息',
        params: t.Object({
          revisionID: t.Integer({ minimum: 1 }),
        }),
        security: [{ [Security.CookiesSession]: [], [Security.HTTPBearer]: [] }],
        response: {
          200: res.Ref(PersonCharacterRelationWiki),
          404: res.Ref(res.Error, {
            'x-examples': formatErrors(new NotFoundError('revision')),
          }),
        },
      },
    },
    async ({ params: { revisionID } }): Promise<IPersonCharacterRelationWiki> => {
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

      const revContent = revRecord[revisionID] as PersonCharacterRev;

      const subjects = await fetcher.fetchSlimSubjectsByIDs(
        Object.values(revContent).map(({ subject_id: id }) => +id),
      );
      const characters = await fetcher.fetchSlimCharactersByIDs(
        Object.values(revContent).map(({ crt_id: id }) => +id),
      );

      const relatedData = Object.values(revContent).map(
        ({ subject_id: subjectId, crt_id: characterId }) => {
          return {
            subjectId: +subjectId,
            subjectName: subjects[+subjectId]?.name || '',
            characterId: +characterId,
            characterName: characters[+characterId]?.name || '',
          };
        },
      );

      return relatedData;
    },
  );
}
