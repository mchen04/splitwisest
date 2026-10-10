"use client";

import { useMemo } from "react";
import { ChartBar } from "lucide-react";
import { Card } from "./ui";
import { BarChart, TimeChart } from "./charts";

interface ChartExpense {
  categoryName: string | null;
  date: string;
  payerName: string;
  convertedCents: number;
}

// Spending breakdowns (by category / month / payer) for a group's expense list.
export function SpendCharts({ expenses, currency }: { expenses: ChartExpense[]; currency: string }) {
  const charts = useMemo(() => {
    const byCat = new Map<string, number>();
    const byMonth = new Map<string, number>();
    const byPayer = new Map<string, number>();
    for (const e of expenses) {
      const cat = e.categoryName ?? "Uncategorized";
      byCat.set(cat, (byCat.get(cat) ?? 0) + e.convertedCents);
      const m = String(e.date).slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + e.convertedCents);
      byPayer.set(e.payerName, (byPayer.get(e.payerName) ?? 0) + e.convertedCents);
    }
    const desc = (map: Map<string, number>) =>
      [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    return {
      byCat: desc(byCat),
      byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12)
        .map(([label, value]) => ({ label: label.slice(2), value })),
      byPayer: desc(byPayer),
    };
  }, [expenses]);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-section font-semibold"><ChartBar className="h-4 w-4" /> By category</h3>
        <BarChart data={charts.byCat} currency={currency} title="Spending by category" />
      </Card>
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-section font-semibold"><ChartBar className="h-4 w-4" /> Over time</h3>
        <TimeChart data={charts.byMonth} currency={currency} />
      </Card>
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-section font-semibold"><ChartBar className="h-4 w-4" /> Paid by person</h3>
        <BarChart data={charts.byPayer} currency={currency} title="Total paid by person" />
      </Card>
    </div>
  );
}
