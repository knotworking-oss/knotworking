/** Provider-neutral sales boundary. Adapters call these transaction-safe commands rather than
 * writing tables or mirroring demand. Person-only approval routes remain authoritative. */
export {
  createSalesOrder,
  saveSalesOrder,
  getSalesOrder,
  listSalesOrders,
  salesHistory,
  listSalesPrices,
  salesCommitments,
  listSalesReferences,
  mapSalesReference,
} from "../sales";
