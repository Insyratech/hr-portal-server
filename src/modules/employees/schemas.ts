import { Type } from '@sinclair/typebox';

export const employeeBody = Type.Object({
  employeeCode: Type.String({ minLength: 1 }),
  fullName: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 3 }),
  phone: Type.Optional(Type.String()),
  dateOfBirth: Type.Optional(Type.String()),
  departmentId: Type.Optional(Type.String({ minLength: 1 })),
  designationId: Type.Optional(Type.String({ minLength: 1 })),
  joiningDate: Type.String({ minLength: 1 }),
  employmentType: Type.Union([
    Type.Literal('full_time'),
    Type.Literal('part_time'),
    Type.Literal('contract'),
    Type.Literal('intern'),
  ]),
  managerId: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
  roleId: Type.Optional(Type.String({ minLength: 1 })),
  roleIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  password: Type.String({ minLength: 8 }),
});

export const employeePatchBody = Type.Object({
  employeeCode: Type.Optional(Type.String({ minLength: 1 })),
  fullName: Type.Optional(Type.String({ minLength: 1 })),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notificationEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  dateOfBirth: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  departmentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  designationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  joiningDate: Type.Optional(Type.String({ minLength: 1 })),
  employmentType: Type.Optional(
    Type.Union([
      Type.Literal('full_time'),
      Type.Literal('part_time'),
      Type.Literal('contract'),
      Type.Literal('intern'),
    ]),
  ),
  managerId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
  roleId: Type.Optional(Type.String({ minLength: 1 })),
  roleIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
});
