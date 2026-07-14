import { z } from 'zod';

/** Customer-selectable archetype states. Internal and non-selectable entries never cross the API. */
export const PublicArchetypeStatusSchema = z.enum(['launch', 'available']);

export const PublicArchetypeSchema = z.object({
  id: z.string().min(1),
  display_label: z.string().min(1),
  device: z.string().min(1),
  ios_version: z.string().min(1),
  safari_version: z.string().min(1),
  canvas_family: z.enum(['A', 'B']),
  status: PublicArchetypeStatusSchema,
  is_default: z.boolean(),
});

export const ListArchetypesResponseSchema = z.object({
  default_archetype_id: z.string().min(1),
  data: z.array(PublicArchetypeSchema),
});

export type PublicArchetypeStatus = z.infer<typeof PublicArchetypeStatusSchema>;
export type PublicArchetype = z.infer<typeof PublicArchetypeSchema>;
export type ListArchetypesResponse = z.infer<typeof ListArchetypesResponseSchema>;
