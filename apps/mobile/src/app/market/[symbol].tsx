import { router, Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { OrderBook } from "@/components/OrderBook";
import { PriceChart } from "@/components/PriceChart";
import { Button, Card, ErrorState, KeyValue, Screen, SectionTitle, Skeleton } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { num, pct, price, usd } from "@/lib/format";
import { fundingApr } from "@/lib/markets";
import { useBook, useCandles, useMarkets } from "@/lib/queries";
import { colors, space, type } from "@/theme";

export default function MarketDetail() {
  const { symbol = "" } = useLocalSearchParams<{ symbol: string }>();
  const markets = useMarkets();
  const candles = useCandles(symbol);
  const book = useBook(symbol);
  const m = markets.data?.find((x) => x.symbol === symbol);
  const up = (m?.change24hPct ?? 0) >= 0;

  return (
    <Screen edges={["bottom"]} refreshing={candles.isRefetching} onRefresh={() => { void candles.refetch(); void book.refetch(); void markets.refetch(); }}>
      <Stack.Screen options={{ title: `${symbol}-PERP` }} />
      <View>
        <Text style={type.label}>{symbol} mark price</Text>
        {m ? (
          <>
            <Text style={[type.hero, styles.hero]}>{price(m.markPx)}</Text>
            <Text style={[type.small, { color: up ? colors.good : colors.bad }]}>{`${up ? "+" : ""}${num(m.change24hPct, 2)}% in 24h`}</Text>
          </>
        ) : markets.error ? (
          <Text style={[type.small, { color: colors.warn }]}>{errorMessage(markets.error)}</Text>
        ) : (
          <Skeleton width={180} height={44} style={{ marginTop: space.sm }} />
        )}
      </View>

      <Card>
        {candles.isLoading ? (
          <Skeleton height={180} />
        ) : candles.error ? (
          <ErrorState title="No chart" message={errorMessage(candles.error)} onRetry={() => void candles.refetch()} />
        ) : (candles.data?.length ?? 0) < 2 ? (
          <Text style={type.small}>Not enough trades in the last 24 hours to draw a chart.</Text>
        ) : (
          <PriceChart candles={candles.data ?? []} />
        )}
      </Card>

      {m && (
        <Card>
          <KeyValue label="Max leverage" value={`${num(m.maxLeverage, 0)}x`} />
          <KeyValue label="Funding (per interval)" value={pct(m.fundingRate, 4, true)} />
          <KeyValue label="Funding (yearly)" value={pct(fundingApr(m), 1, true)} />
          <KeyValue label="Open interest" value={usd(m.openInterestUsd, 0)} />
          <KeyValue label="24h volume" value={usd(m.dayVolumeUsd, 0)} />
          <KeyValue label="Taker fee" value={`${num(m.takerFee * 10_000, 2)} bps`} />
        </Card>
      )}

      <SectionTitle title="Order book" />
      <Card>
        {book.isLoading ? <Skeleton height={160} /> : book.error ? <Text style={[type.small, { color: colors.warn }]}>{errorMessage(book.error)}</Text> : book.data ? <OrderBook book={book.data} /> : null}
      </Card>

      <View style={styles.cta}>
        <Button title="Long" variant="good" icon="trending-up" style={styles.flex} disabled={!m} onPress={() => router.push({ pathname: "/trade/[symbol]", params: { symbol, side: "long" } })} />
        <Button title="Short" variant="danger" icon="trending-down" style={styles.flex} disabled={!m} onPress={() => router.push({ pathname: "/trade/[symbol]", params: { symbol, side: "short" } })} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hero: { marginTop: space.xs },
  cta: { flexDirection: "row", gap: space.md },
});
