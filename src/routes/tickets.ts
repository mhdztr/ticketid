import { Router } from 'express';
import { listTicketsByBuyer } from '../services/paymentService.js';
import { requireBuyerId } from './orders.js';

export const ticketsRouter = Router();

ticketsRouter.get('/', async (req, res) => {
  const buyerId = requireBuyerId(req);
  const tickets = await listTicketsByBuyer(buyerId);
  res.json({ tickets });
});
