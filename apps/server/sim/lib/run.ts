import { addDays } from "@knotworking/core";
import type { World } from "./world";
import type { Plant } from "./plant";
import type { Compliance } from "./compliance";

export const dow = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** Run the working days from `from` (exclusive of setup day) to `to` inclusive. */
export async function runDays(w: World, plant: Plant, from: string, to: string, comp?: Compliance) {
  let day = from;
  while (day <= to) {
    const d = dow(day);
    w.setDay(day, 8);
    if (d === 1) await w.signInAll();
    w.setDay(day, 9);
    if (d >= 1 && d <= 5) {
      if (d === 1 || d === 4) await plant.raiseOrders(day, 0.55, 2);
      await plant.goodsIn(day);
      await plant.qaRelease(day);
      await plant.takeOrders(day);
      await plant.produce(day);
      await plant.qaRelease(day);
      await plant.despatch(day);
      if (comp) {
        await comp.daily(day, plant);
        await comp.quality(day, plant);
        if (d === 3 && Number(day.slice(8)) <= 7) await comp.mockRecall(day, plant);
        if (d === 2 && Number(day.slice(8)) <= 7 && day.slice(5, 7) === "06") await comp.refreshTraining(day);
      }
      if (d === 5) {
        await plant.wasteExpired(day);
        await plant.checkInvariants(day);
      }
    }
    day = addDays(day, 1);
  }
}
