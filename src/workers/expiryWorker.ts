import { config } from '../config.js';
import { expirePendingOrders } from '../services/orderService.js';

export function startExpiryWorker(
  intervalMs = config.expirySweepIntervalMs
): { stop: () => void } {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await expirePendingOrders();
    } catch (err) {
      console.error('Expiry sweep failed:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
