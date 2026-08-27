import { Type } from '@sinclair/typebox';

const money = Type.Number({ minimum: 0 });

export const compensationBody = Type.Object({
  basic: Type.Optional(money),
  da: Type.Optional(money),
  hra: Type.Optional(money),
  fuel: Type.Optional(money),
  incentives: Type.Optional(money),
  other: Type.Optional(money),
  professionalTax: Type.Optional(money),
  tds: Type.Optional(money),
  employeeWelfare: Type.Optional(money),
  kpi: Type.Optional(money),
  otherDeductions: Type.Optional(money),
  effectiveFrom: Type.Optional(Type.String({ minLength: 10 })),
});

export const paymentBody = Type.Object({
  pan: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  bankAccountNumber: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  bankName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ifsc: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const employeeBody = Type.Object({
  employeeCode: Type.String({ minLength: 1 }),
  fullName: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 3 }),
  phone: Type.Optional(Type.String()),
  dateOfBirth: Type.Optional(Type.String()),
  departmentId: Type.Optional(Type.String({ minLength: 1 })),
  designationId: Type.Optional(Type.String({ minLength: 1 })),
  companyId: Type.Optional(Type.String({ minLength: 1 })),
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
  shiftId: Type.Optional(Type.String({ minLength: 1 })),
  compensation: Type.Optional(compensationBody),
  payment: Type.Optional(paymentBody),
  leaveAllocations: Type.Optional(
    Type.Array(
      Type.Object({
        leaveTypeId: Type.String({ minLength: 1 }),
        allocated: Type.Number({ minimum: 0 }),
      }),
    ),
  ),
  emailVerificationToken: Type.Optional(Type.String({ minLength: 8 })),
});

export const employeePatchBody = Type.Object({
  employeeCode: Type.Optional(Type.String({ minLength: 1 })),
  fullName: Type.Optional(Type.String({ minLength: 1 })),
  phone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  notificationEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  dateOfBirth: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  departmentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  designationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  companyId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
});

/** Body for PATCH /employees/:id/roles — hats; Employee is always kept server-side. */
export const employeeRolesBody = Type.Object({
  roleIds: Type.Array(Type.String({ minLength: 1 })),
});

/** Body for PATCH /employees/:id/company — HR assigns company. */
export const employeeCompanyBody = Type.Object({
  companyId: Type.String({ minLength: 1 }),
});

export const workWeekBody = Type.Object({
  pattern: Type.Union([
    Type.Literal('SUNDAY_OFF'),
    Type.Literal('WEEKEND_OFF'),
    Type.Literal('SECOND_FOURTH_SATURDAY'),
  ]),
  effectiveFrom: Type.String({ minLength: 10 }),
});

export const workEmailOtpBody = Type.Object({
  email: Type.String({ minLength: 3 }),
});

export const workEmailOtpVerifyBody = Type.Object({
  email: Type.String({ minLength: 3 }),
  code: Type.String({ minLength: 4, maxLength: 4 }),
});
