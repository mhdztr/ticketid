import { type Request, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import {
  cancelOrder,
  createOrder,
  getOrderById,
  listOrdersByBuyer,
} from '../services/orderService.js';

const createOrderSchema = z.object({
  ticket_type_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(4),
});

const orderIdParamSchema = z.string().uuid();

export function requireBuyerId(req: Request): string {
  const buyerId = req.header('x-buyer-id')?.trim();
  if (!buyerId || buyerId.length > 100) {
    throw new AppError(400, 'MISSING_BUYER_ID', 'X-Buyer-Id header is required');
  }
  return buyerId;
}

export const ordersRouter = Router();

ordersRouter.post('/', async (req, res) => {
  const buyerId = requireBuyerId(req);
  const payload = createOrderSchema.parse(req.body);
  const order = await createOrder({
    buyerId,
    ticketTypeId: payload.ticket_type_id,
    quantity: payload.quantity,
  });
  res.status(201).json(order);
});

ordersRouter.get('/', async (req, res) => {
  const buyerId = requireBuyerId(req);
  const orders = await listOrdersByBuyer(buyerId);
  res.json({ orders });
});

ordersRouter.get('/:id', async (req, res) => {
  const buyerId = requireBuyerId(req);
  const orderId = orderIdParamSchema.parse(req.params.id);
  const order = await getOrderById(buyerId, orderId);
  res.json(order);
});

ordersRouter.post('/:id/cancel', async (req, res) => {
  const buyerId = requireBuyerId(req);
  const orderId = orderIdParamSchema.parse(req.params.id);
  const order = await cancelOrder(buyerId, orderId);
  res.json(order);
});
