import { z } from "zod";

/**
 * People module: the staff register. Most shop-floor staff never sign in, so a member of staff is
 * not a user: they have a 6-digit staff number and a 6-digit PIN for the kiosk, and may be linked
 * to a workspace member. Training and attendance build on it. No DOM or Node APIs.
 */

/** Staff numbers are exactly six digits, kept as text so leading zeros survive. */
export const STAFF_NUMBER_LENGTH = 6;
export const STAFF_PIN_LENGTH = 6;
const sixDigits = /^\d{6}$/;

export const isStaffNumber = (value: string) => sixDigits.test(value);

/** Wrong PINs in a row before a staff number is locked, and for how long. */
export const STAFF_PIN_MAX_ATTEMPTS = 5;
export const STAFF_PIN_LOCK_MINUTES = 15;

/**
 * PINs too easy to guess: one digit repeated, a straight run up or down (`123456`, `987654`), a
 * repeated pair or triple (`121212`, `123123`), or the person's own staff number.
 */
export function isWeakPin(pin: string, staffNumber?: string | null): boolean {
  if (!sixDigits.test(pin)) return true;
  if (staffNumber && pin === staffNumber) return true;
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  if (steps.every((s) => s === 0)) return true;
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true;
  if (pin === pin.slice(0, 2).repeat(3) || pin === pin.slice(0, 3).repeat(2)) return true;
  return false;
}

/**
 * The staff number to suggest for a new person: one above the highest in use (leavers and
 * deleted people included, since numbers are never reused), starting at `100001` so new numbers
 * don't begin with a zero. `null` when the six-digit range is used up.
 */
export function nextStaffNumber(taken: Iterable<string>): string | null {
  let max = 100_000;
  for (const n of taken) if (isStaffNumber(n)) max = Math.max(max, Number(n));
  if (max < 999_999) return String(max + 1);
  // Past the top: the lowest gap, if any.
  const used = new Set(taken);
  for (let n = 1; n <= 999_999; n++) {
    const candidate = String(n).padStart(STAFF_NUMBER_LENGTH, "0");
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

export const staffStatuses = ["active", "leaver"] as const;
export type StaffStatus = (typeof staffStatuses)[number];
export const staffStatusLabels: Record<StaffStatus, string> = { active: "Active", leaver: "Leaver" };

export const jobRoleStatuses = ["active", "archived"] as const;
export type JobRoleStatus = (typeof jobRoleStatuses)[number];

export const staffDisplayName = (s: { firstName: string; lastName: string }) =>
  `${s.firstName} ${s.lastName}`;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
const isoDate = z.iso.date();
const staffNumber = z
  .string()
  .trim()
  .regex(sixDigits, `A staff number is exactly ${STAFF_NUMBER_LENGTH} digits`);
const pin = z.string().regex(sixDigits, `A PIN is exactly ${STAFF_PIN_LENGTH} digits`);

const staffFields = {
  staffNumber,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  jobTitle: optionalText(200),
  department: optionalText(200),
  startDate: isoDate.nullable(),
  /** Last day of employment; set when someone becomes a leaver. */
  endDate: isoDate.nullable(),
  /** The employee number in the payroll package, when it differs from the staff number. */
  payrollReference: optionalText(60),
  /** A workspace member this person signs in as, if any. */
  userId: z.uuid().nullable(),
  /** Replaces the person's job roles. */
  jobRoleIds: z
    .array(z.uuid())
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate job role"),
};

const datesInOrder = (s: { startDate?: string | null; endDate?: string | null }) =>
  !s.startDate || !s.endDate || s.startDate <= s.endDate;

export const staffCreateSchema = z
  .object({
    id: z.uuid().optional(),
    /** Default: the next free number (`nextStaffNumber`). */
    staffNumber: staffFields.staffNumber.optional(),
    firstName: staffFields.firstName,
    lastName: staffFields.lastName,
    jobTitle: staffFields.jobTitle.optional(),
    department: staffFields.department.optional(),
    startDate: staffFields.startDate.optional(),
    payrollReference: staffFields.payrollReference.optional(),
    userId: staffFields.userId.optional(),
    jobRoleIds: staffFields.jobRoleIds.optional(),
  })
  .refine(datesInOrder, { message: "The start date is after the end date", path: ["endDate"] });
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;

export const staffUpdateSchema = z
  .object({ ...staffFields, status: z.enum(staffStatuses) })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update")
  .refine(datesInOrder, { message: "The start date is after the end date", path: ["endDate"] });
export type StaffUpdateInput = z.infer<typeof staffUpdateSchema>;

export const staffListQuerySchema = z.object({
  /** Name, staff number, payroll reference, job title or department. */
  q: z.string().trim().max(200).optional(),
  /** Default: active staff only. */
  status: z.enum([...staffStatuses, "all"]).default("active"),
  jobRoleId: z.uuid().optional(),
  department: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type StaffListQuery = z.infer<typeof staffListQuerySchema>;

/** Setting a PIN. Without `pin` the server generates one and returns it once. */
export const staffPinSetSchema = z.object({ pin: pin.optional() });
export type StaffPinSetInput = z.infer<typeof staffPinSetSchema>;

/** A person changing their own PIN at the kiosk. */
export const staffPinChangeSchema = z.object({ staffNumber, currentPin: pin, newPin: pin });
export type StaffPinChangeInput = z.infer<typeof staffPinChangeSchema>;

export const jobRoleCreateSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120),
  description: optionalText(2000).optional(),
});
export type JobRoleCreateInput = z.infer<typeof jobRoleCreateSchema>;

export const jobRoleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: optionalText(2000),
    status: z.enum(jobRoleStatuses),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update");
export type JobRoleUpdateInput = z.infer<typeof jobRoleUpdateSchema>;

export const jobRoleListQuerySchema = z.object({
  status: z.enum([...jobRoleStatuses, "all"]).default("active"),
});
export type JobRoleListQuery = z.infer<typeof jobRoleListQuerySchema>;
