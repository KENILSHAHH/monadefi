import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import type { Candle } from "@/lib/api/types";
import { price } from "@/lib/format";
import { colors, space, type } from "@/theme";

/** Path data for a line through the close prices, scaled into width x height. */
export function linePath(closes: number[], width: number, height: number, pad = 4): string {
  if (closes.length < 2 || width <= 0) return "";
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const stepX = width / (closes.length - 1);
  return closes
    .map((c, i) => {
      const x = i * stepX;
      const y = pad + (1 - (c - min) / span) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function PriceChart({ candles, height = 180 }: { candles: Candle[]; height?: number }) {
  const [width, setWidth] = useState(0);
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const closes = sorted.map((c) => c.c);
  const first = closes[0] ?? 0;
  const last = closes[closes.length - 1] ?? 0;
  const up = last >= first;
  const stroke = up ? colors.good : colors.bad;
  const d = linePath(closes, width, height);
  const high = sorted.length ? Math.max(...sorted.map((c) => c.h)) : 0;
  const low = sorted.length ? Math.min(...sorted.map((c) => c.l)) : 0;

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessibilityLabel={`Price chart. From ${price(first)} to ${price(last)}.`}>
      {width > 0 && d ? (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={stroke} stopOpacity={0.28} />
              <Stop offset="1" stopColor={stroke} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke={colors.line} strokeDasharray="3 5" />
          <Path d={`${d} L${width},${height} L0,${height} Z`} fill="url(#fill)" />
          <Path d={d} stroke={stroke} strokeWidth={2} fill="none" strokeLinejoin="round" />
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
      <View style={styles.legend}>
        <Text style={type.tiny}>24h low {price(low)}</Text>
        <Text style={type.tiny}>24h high {price(high)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: "row", justifyContent: "space-between", marginTop: space.sm },
});
