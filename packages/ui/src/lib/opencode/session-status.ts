import { z } from "zod"

// v2 reports active loops globally. A malformed response cannot prove idle.
export const activeSessionSnapshotSchema = z.record(z.string().min(1), z.object({ type: z.literal("running") }))

const pendingFormSchema = z.object({ id: z.string().min(1), sessionID: z.string().min(1), title: z.string() }).passthrough()
const pendingPermissionSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  action: z.string(),
  resources: z.array(z.string()),
}).passthrough()

/** Narrow validation for OpenChamber's cross-directory host seed endpoint. */
export const hostSessionStatusSnapshotSchema = z.object({
  serverTime: z.number().finite(),
  sessions: z.record(z.string().min(1), z.object({
    status: z.enum(["busy", "retry", "idle"]),
    lastUpdateAt: z.number().finite(),
  }).passthrough()),
  pending: z.record(z.string().min(1), z.object({
    permissions: z.array(pendingPermissionSchema),
    forms: z.array(pendingFormSchema),
  })).default({}),
})

export type HostSessionStatusSnapshot = z.infer<typeof hostSessionStatusSnapshotSchema>
