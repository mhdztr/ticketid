import { Router } from 'express';
import { z } from 'zod';
import { createEvent, getEventById, listEvents } from '../services/eventService.js';

const ticketTypeInputSchema = z.object({
  category: z.enum(['REGULER', 'VIP']),
  price: z.number().int().min(0),
  quota: z.number().int().min(1),
});

const createEventSchema = z.object({
  title: z.string().trim().min(2).max(150),
  description: z.string().trim().max(1000).optional().default(''),
  venue: z.string().trim().min(2).max(150),
  event_date: z.string().datetime({ offset: true }),
  max_tickets_per_buyer: z.number().int().min(1).max(4).optional().default(4),
  ticket_types: z
    .array(ticketTypeInputSchema)
    .length(2)
    .refine(
      (items) => {
        const categories = new Set(items.map((item) => item.category));
        return categories.has('REGULER') && categories.has('VIP');
      },
      { message: 'Event must include both REGULER and VIP ticket types' }
    ),
});

const eventIdParamSchema = z.string().uuid();

export const eventsRouter = Router();

eventsRouter.post('/', async (req, res) => {
  const payload = createEventSchema.parse(req.body);
  const event = await createEvent(payload);
  res.status(201).json(event);
});

eventsRouter.get('/', async (_req, res) => {
  const events = await listEvents();
  res.json({ events });
});

eventsRouter.get('/:id', async (req, res) => {
  const eventId = eventIdParamSchema.parse(req.params.id);
  const event = await getEventById(eventId);
  res.json(event);
});
