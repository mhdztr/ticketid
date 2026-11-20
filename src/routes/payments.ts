import { Router } from 'express';
import { z } from 'zod';
import type { RawBodyRequest } from '../app.js';
import { AppError } from '../errors.js';
import {
  listPaymentWebhooks,
  processPaymentWebhook,
  simulatePayment,
  verifyWebhookSignature,
} from '../services/paymentService.js';

const webhookSchema = z.object({
  webhook_id: z.string().trim().min(1).max(120),
  order_id: z.string().uuid(),
  status: z.enum(['PAID', 'FAILED']),
});

const simulateSchema = z.object({
  order_id: z.string().uuid(),
  mode: z.enum(['normal', 'duplicate', 'late', 'failed']).optional().default('normal'),
});

const orderIdQuerySchema = z.string().uuid().optional();

export const webhooksRouter = Router();

webhooksRouter.post('/payments', async (req, res) => {
  const rawBody = (req as RawBodyRequest).rawBody;
  const signature = req.header('x-webhook-signature');

  if (!verifyWebhookSignature(rawBody, signature)) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }

  const payload = webhookSchema.parse(req.body);
  const result = await processPaymentWebhook({
    webhookId: payload.webhook_id,
    orderId: payload.order_id,
    status: payload.status,
    rawPayload: req.body,
  });

  // Always return 200 for accepted/logged webhooks so real providers stop retrying
  res.json(result);
});

export const paymentsRouter = Router();

paymentsRouter.post('/simulate', async (req, res) => {
  const payload = simulateSchema.parse(req.body);
  const result = await simulatePayment(payload.order_id, payload.mode);
  res.json(result);
});

paymentsRouter.get('/webhooks', async (req, res) => {
  const orderId = orderIdQuerySchema.parse(req.query.order_id);
  const webhooks = await listPaymentWebhooks(orderId);
  res.json({ webhooks });
});
