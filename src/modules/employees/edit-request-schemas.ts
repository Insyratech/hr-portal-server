import { Type } from '@sinclair/typebox';

export const createEditRequestBody = Type.Object({
  targetEmployeeId: Type.String({ format: 'uuid' }),
  reason: Type.String({ minLength: 8, maxLength: 2000 }),
  fieldHints: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
});

export const decideEditRequestBody = Type.Object({
  note: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  unlockHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
});
