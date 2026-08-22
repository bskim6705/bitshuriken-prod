import { api } from "./client";
import type { CreateOcoReq, CreateOrderReq, Order, OrderList } from "@/lib/types/trading";

// replacesOrderId 지정 시 BE는 {order, replaced} 형태로 응답
export type CreateOrderRes =
  | Order
  | { order: Order; replaced: { orderId: string; cancelRequested: boolean } };

export interface CreateOcoRes {
  orderList: OrderList;
  orders: Order[];
}

export function createOrder(req: CreateOrderReq): Promise<CreateOrderRes> {
  return api.post<CreateOrderRes>("/spot/trading/orders", { ...req });
}

// OCO 레그 취소 시 BE는 리스트 전체 취소 결과 {orderList, orders}로 응답
export function cancelOrder(id: string): Promise<Order | CreateOcoRes> {
  return api.del<Order | CreateOcoRes>(`/spot/trading/orders/${id}`);
}

export function cancelAllOrders(symbol: string): Promise<Order[]> {
  const params = new URLSearchParams({ symbol });
  return api.del<Order[]>(`/spot/trading/open-orders?${params.toString()}`);
}

export function createOco(req: CreateOcoReq): Promise<CreateOcoRes> {
  return api.post<CreateOcoRes>("/spot/trading/order-lists", { ...req });
}

export function cancelOco(id: string): Promise<CreateOcoRes> {
  return api.del<CreateOcoRes>(`/spot/trading/order-lists/${id}`);
}
