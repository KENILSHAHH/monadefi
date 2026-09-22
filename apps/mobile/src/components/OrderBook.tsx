import { StyleSheet, Text, View } from "react-native";
import type { BookLevel, OrderBook as Book } from "@/lib/api/types";
import { num, price } from "@/lib/format";
import { colors, space, type } from "@/theme";

function Side({ levels, side, maxSize }: { levels: BookLevel[]; side: "bid" | "ask"; maxSize: number }) {
  const color = side === "bid" ? colors.good : colors.bad;
  return (
    <View style={styles.side}>
      {levels.map((l) => (
        <View key={`${side}-${l.px}`} style={styles.level}>
          <View style={[styles.depth, side === "bid" ? styles.depthRight : styles.depthLeft, { width: `${(l.size / maxSize) * 100}%`, backgroundColor: `${color}1F` }]} />
          {side === "bid" ? (
            <>
              <Text style={[type.mono, styles.size]}>{num(l.size, 4)}</Text>
              <Text style={[type.mono, { color }]}>{price(l.px)}</Text>
            </>
          ) : (
            <>
              <Text style={[type.mono, { color }]}>{price(l.px)}</Text>
              <Text style={[type.mono, styles.size]}>{num(l.size, 4)}</Text>
            </>
          )}
        </View>
      ))}
    </View>
  );
}

/** Bids on the left, asks on the right, with a depth bar per level. */
export function OrderBook({ book, levels = 8 }: { book: Book; levels?: number }) {
  const bids = book.bids.slice(0, levels);
  const asks = book.asks.slice(0, levels);
  const maxSize = Math.max(1e-12, ...bids.map((b) => b.size), ...asks.map((a) => a.size));
  const bestBid = bids[0]?.px;
  const bestAsk = asks[0]?.px;
  const spread = bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000 : null;
  return (
    <View>
      <View style={styles.header}>
        <Text style={type.tiny}>Size · Bid</Text>
        <Text style={type.tiny}>{spread === null ? "" : `Spread ${num(spread, 1)} bps`}</Text>
        <Text style={type.tiny}>Ask · Size</Text>
      </View>
      <View style={styles.row}>
        <Side levels={bids} side="bid" maxSize={maxSize} />
        <Side levels={asks} side="ask" maxSize={maxSize} />
      </View>
      {bids.length === 0 && asks.length === 0 && <Text style={type.small}>The book is empty now.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: space.sm },
  row: { flexDirection: "row", gap: space.sm },
  side: { flex: 1, gap: 2 },
  level: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, paddingHorizontal: 4 },
  depth: { position: "absolute", top: 0, bottom: 0, borderRadius: 3 },
  depthRight: { right: 0 },
  depthLeft: { left: 0 },
  size: { color: colors.dim },
});
