import Slider from "@react-native-community/slider";
import { useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { IntentConfirm } from "@/components/IntentConfirm";
import { Brand, Logo } from "@/components/Logo";
import { RiskCard } from "@/components/RiskCard";
import { Button, Card, Chip, ErrorState, KeyValue, Notice, Screen, Segmented, Sheet, Skeleton, haptic } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { Intent, RiskCheckResponse, RiskVerdict, Side, TradePreviewBody, TradePreviewResponse } from "@/lib/api/types";
import { fixed, num, parseAmount, price, usd } from "@/lib/format";
import { clampLeverage, PERPL_MIN_DEPOSIT, roughLiquidation } from "@/lib/markets";
import { keys, useBalance, useMarkets } from "@/lib/queries";
import { ensureSessionBefore, useTradingSession } from "@/lib/session";
import { colors, fonts, radius, space, type } from "@/theme";

type Phase = { tag: "edit" } | { tag: "checking" } | { tag: "checked"; risk: RiskCheckResponse; forKey: string } | { tag: "previewing"; risk: RiskCheckResponse; forKey: string };

export default function TradeTicket() {
  const params = useLocalSearchParams<{ symbol: string; side?: string }>();
  const symbol = params.symbol ?? "";
  const qc = useQueryClient();
  const markets = useMarkets();
  const balance = useBalance();
  const trading = useTradingSession();
  const m = markets.data?.find((x) => x.symbol === symbol);
  const maxLev = Math.max(1, Math.floor(m?.maxLeverage ?? 1));

  const [side, setSide] = useState<Side>(params.side === "short" ? "short" : "long");
  const [marginText, setMarginText] = useState("");
  const [leverage, setLeverage] = useState(Math.min(3, maxLev));
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitText, setLimitText] = useState("");
  const [useSl, setUseSl] = useState(false);
  const [slText, setSlText] = useState("");
  const [useTp, setUseTp] = useState(false);
  const [tpText, setTpText] = useState("");
  const [phase, setPhase] = useState<Phase>({ tag: "edit" });
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TradePreviewResponse | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; risk?: RiskVerdict } | null>(null);
  const [final, setFinal] = useState<Intent | null>(null);
  const lastBody = useRef<TradePreviewBody | null>(null);

  const lev = clampLeverage(leverage, maxLev);
  const margin = parseAmount(marginText);
  const limitPx = orderType === "limit" ? parseAmount(limitText) : null;
  const slPx = useSl ? parseAmount(slText) : null;
  const tpPx = useTp ? parseAmount(tpText) : null;
  const available = (balance.data?.ausd.wallet ?? 0) + (balance.data?.ausd.perplFree ?? 0);
  const ref = limitPx ?? (side === "long" ? m?.askPx : m?.bidPx) ?? m?.markPx ?? 0;
  const notional = (margin ?? 0) * lev;
  const liq = m ? roughLiquidation(ref, lev, m.maintenanceMargin, side) : null;

  // The risk verdict belongs to exact inputs. Any change asks for a new check.
  const inputKey = `${symbol}|${side}|${lev}|${margin ?? ""}`;
  const risk = phase.tag === "checked" || phase.tag === "previewing" ? (phase.forKey === inputKey ? phase.risk : null) : null;

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!margin) p.push("Enter the margin in AUSD.");
    else if (balance.data && margin > available + 1e-9) p.push(`You have ${fixed(available, 2)} AUSD in your wallet and on Perpl.`);
    if (orderType === "limit" && !limitPx) p.push("Enter a limit price.");
    if (useSl && !slPx) p.push("Enter a stop-loss price or turn it off.");
    if (useTp && !tpPx) p.push("Enter a take-profit price or turn it off.");
    if (slPx && ref && (side === "long" ? slPx >= ref : slPx <= ref)) p.push(side === "long" ? "A stop-loss for a long must be below the price." : "A stop-loss for a short must be above the price.");
    if (tpPx && ref && (side === "long" ? tpPx <= ref : tpPx >= ref)) p.push(side === "long" ? "A take-profit for a long must be above the price." : "A take-profit for a short must be below the price.");
    return p;
  }, [margin, available, balance.data, orderType, limitPx, useSl, slPx, useTp, tpPx, ref, side]);

  async function checkRisk() {
    if (!margin) return;
    setError(null);
    setBlocked(null);
    setPhase({ tag: "checking" });
    try {
      const r = await api.risk.check({ market: symbol, side, leverage: lev, marginUsd: margin });
      if (r.decision === "block" || r.blocked) haptic.error();
      setPhase({ tag: "checked", risk: r, forKey: inputKey });
    } catch (e) {
      setError(errorMessage(e, "The Nansen risk check did not answer."));
      setPhase({ tag: "edit" });
    }
  }

  async function previewOrder() {
    if (!margin || !risk) return;
    setError(null);
    setPhase({ tag: "previewing", risk, forKey: inputKey });
    const body: TradePreviewBody = {
      market: symbol, side, leverage: lev, marginUsd: margin, orderType,
      ...(limitPx ? { limitPx } : {}), ...(slPx ? { stopLossPx: slPx } : {}), ...(tpPx ? { takeProfitPx: tpPx } : {}),
    };
    lastBody.current = body;
    try {
      // Trading access sets itself up after the passkey. This waits for it only when it is not ready yet.
      await ensureSessionBefore();
      const r = await api.trade.preview(body);
      setPreview(r);
      setPhase({ tag: "checked", risk, forKey: inputKey });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        haptic.error();
        setBlocked({ message: e.message, ...(e.body?.risk ? { risk: e.body.risk } : {}) });
      } else setError(errorMessage(e, "The order preview failed."));
      setPhase({ tag: "checked", risk, forKey: inputKey });
    }
  }

  /** After a session_inactive failure: the same order as a new pending intent, which IntentConfirm confirms once. */
  const retryPreview = async (): Promise<Intent | null> => {
    if (!lastBody.current) return null;
    const r = await api.trade.preview(lastBody.current);
    return r.intent;
  };

  const finish = () => {
    setPreview(null);
    void qc.invalidateQueries({ queryKey: keys.positions });
    if (final?.status === "done") router.dismissTo("/(tabs)");
  };

  if (!m) {
    return (
      <Screen>
        <Stack.Screen options={{ title: `Trade ${symbol}` }} />
        {markets.error ? <ErrorState message={errorMessage(markets.error)} onRetry={() => void markets.refetch()} /> : <Skeleton height={300} />}
      </Screen>
    );
  }

  const blockedRisk = blocked?.risk ?? (risk && (risk.decision === "block" || risk.blocked) ? risk : null);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
      <Screen>
        <Stack.Screen options={{ title: `Trade ${symbol}` }} />

        {trading.phase === "revoked" && (
          <Notice tone="accent" icon="key-outline">
            Trading access is off because you revoked it. You can check the risk and preview now. Restore it in Settings before you confirm.
          </Notice>
        )}

        <Card style={styles.head}>
          <Logo kind="token" id={symbol} size={44} badge={{ kind: "protocol", id: "perpl" }} />
          <View style={styles.flexOnly}>
            <Text style={type.title} numberOfLines={1}>
              {symbol}-PERP
            </Text>
            <Brand id="perpl" label="Perpl" />
          </View>
          <View style={styles.headRight}>
            <Text style={type.numBold}>{price(m.markPx)}</Text>
            <Text style={type.tiny}>
              Bid {price(m.bidPx)} · Ask {price(m.askPx)}
            </Text>
          </View>
        </Card>

        <Card style={styles.gap}>
          <Text style={type.label}>Side</Text>
          <Segmented<Side> value={side} onChange={setSide} options={[{ value: "long", label: "Long", tone: "good" }, { value: "short", label: "Short", tone: "bad" }]} />
        </Card>

        <Card style={styles.gap}>
          <View style={styles.labelRow}>
            <Text style={type.label}>Margin</Text>
            <Text style={type.small}>Available {fixed(available, 2)} AUSD</Text>
          </View>
          <View style={styles.amountRow}>
            <TextInput
              value={marginText}
              onChangeText={setMarginText}
              placeholder="0.00"
              placeholderTextColor={colors.faint}
              keyboardType="decimal-pad"
              style={styles.amount}
              accessibilityLabel="Margin in AUSD"
            />
            <View style={styles.unitRow}>
              <Logo kind="token" id="ausd" size={20} />
              <Text style={styles.amountUnit}>AUSD</Text>
            </View>
          </View>
          <View style={styles.chips}>
            {[0.25, 0.5, 1].map((f) => (
              <Chip key={f} label={f === 1 ? "Max" : `${f * 100}%`} onPress={() => setMarginText(available > 0 ? fixed(Math.floor(available * f * 100) / 100, 2).replace(/,/g, "") : "")} />
            ))}
          </View>
          {margin !== null && margin < PERPL_MIN_DEPOSIT && <Text style={type.tiny}>Perpl needs at least {PERPL_MIN_DEPOSIT} AUSD in the account for the first deposit.</Text>}
        </Card>

        <Card style={styles.gap}>
          <View style={styles.labelRow}>
            <Text style={type.label}>Leverage</Text>
            <Text style={[type.title, { color: colors.accent }]}>{lev}x</Text>
          </View>
          <Slider
            minimumValue={1}
            maximumValue={maxLev}
            step={1}
            value={lev}
            onValueChange={(v) => setLeverage(v)}
            onSlidingComplete={() => haptic.tap()}
            minimumTrackTintColor={colors.accent}
            maximumTrackTintColor={colors.line}
            thumbTintColor={colors.ink}
            accessibilityLabel={`Leverage ${lev} times. Maximum ${maxLev}.`}
          />
          <View style={styles.labelRow}>
            <Text style={type.tiny}>1x</Text>
            <Text style={type.tiny}>max {maxLev}x</Text>
          </View>

        </Card>

        <Card style={styles.gap}>
          <Text style={type.label}>Order and exits</Text>
          <Segmented value={orderType} onChange={setOrderType} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]} />
          {orderType === "limit" && <PriceInput label="Limit price" value={limitText} onChange={setLimitText} />}
          <Toggle label="Stop-loss" value={useSl} onChange={setUseSl} />
          {useSl && <PriceInput label="Stop-loss price" value={slText} onChange={setSlText} />}
          <Toggle label="Take-profit" value={useTp} onChange={setUseTp} />
          {useTp && <PriceInput label="Take-profit price" value={tpText} onChange={setTpText} />}
        </Card>

        <Card style={styles.gap}>
          <Text style={type.label}>Summary</Text>
          <KeyValue label="Side" value={`${side === "long" ? "Long" : "Short"} ${lev}x · ${orderType}`} valueStyle={{ color: side === "long" ? colors.good : colors.bad }} />
          <KeyValue label="Margin" value={margin ? `${fixed(margin, 2)} AUSD` : "—"} />
          <KeyValue label="Position size" value={usd(notional)} valueStyle={styles.bold} />
          <KeyValue label="Rough liquidation" value={liq ? price(liq) : "—"} />
          {slPx ? <KeyValue label="Stop-loss" value={price(slPx)} /> : null}
          {tpPx ? <KeyValue label="Take-profit" value={price(tpPx)} /> : null}
        </Card>

        {problems.length > 0 && marginText !== "" && <Notice>{problems[0]}</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}

        {risk && <RiskCard risk={risk} />}
        {blocked && (
          <Notice tone="bad" icon="close-circle">
            {blocked.message}
          </Notice>
        )}
        {blocked?.risk && blocked.risk !== risk && <RiskCard risk={blocked.risk} />}

        {!risk ? (
          <Button title={phase.tag === "checking" ? "Checking with Nansen…" : "Check risk with Nansen"} leading={phase.tag === "checking" ? undefined : <Logo kind="protocol" id="nansen" size={20} />} loading={phase.tag === "checking"} disabled={problems.length > 0} onPress={() => void checkRisk()} />
        ) : blockedRisk ? (
          <Button title="Change the trade" variant="secondary" onPress={() => setPhase({ tag: "edit" })} />
        ) : (
          <Button
            title={risk.decision === "reduce" ? "Preview with the changes" : "Preview order"}
            icon="document-text-outline"
            loading={phase.tag === "previewing"}
            disabled={problems.length > 0}
            onPress={() => void previewOrder()}
          />
        )}
      </Screen>

      <Sheet visible={preview !== null} onClose={finish} title={final?.status === "done" ? "Order filled" : "Confirm order"}>
        {preview && (
          <View style={styles.sheet}>
            {preview.changes.length > 0 && (
              <View style={styles.changes}>
                <View style={styles.unitRow}>
                  <Logo kind="protocol" id="nansen" size={16} />
                  <Text style={type.label}>Nansen changed your order</Text>
                </View>
                {preview.changes.map((c) => (
                  <Text key={c} style={type.body}>
                    {c}
                  </Text>
                ))}
                {preview.applied && (
                  <Text style={type.small}>
                    You asked {num(preview.requested.leverage, 1)}x with {usd(preview.requested.marginUsd)}. Mona-DeFi sends {num(preview.applied.leverage, 1)}x with {usd(preview.applied.marginUsd)}.
                  </Text>
                )}
              </View>
            )}
            <IntentConfirm intent={preview.intent} onSettled={setFinal} onOpenSession={() => setPreview(null)} onRetry={retryPreview} />
            {final && final.status !== "pending" && <Button title="Done" variant="secondary" onPress={finish} />}
          </View>
        )}
      </Sheet>
    </KeyboardAvoidingView>
  );
}

function PriceInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.priceInput}>
      <Text style={type.small}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.faint} style={styles.priceField} accessibilityLabel={label} />
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text style={type.body}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.line }} accessibilityLabel={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  flexOnly: { flex: 1, gap: 2 },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  headRight: { alignItems: "flex-end", gap: 2 },
  unitRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  bold: { ...fonts.sansBold },
  gap: { gap: space.sm },
  top: { marginTop: space.md },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  amountRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  amount: { ...fonts.displayBold, flex: 1, minWidth: 0, fontSize: 38, color: colors.ink, fontVariant: ["tabular-nums"], paddingVertical: space.xs },
  amountUnit: { ...fonts.display, fontSize: 18, color: colors.dim },
  chips: { flexDirection: "row", gap: space.sm },
  priceInput: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  priceField: { ...fonts.sansMedium, minWidth: 140, textAlign: "right", fontSize: 17, color: colors.ink, backgroundColor: colors.raised, borderRadius: radius.sm, paddingHorizontal: space.md, height: 42, fontVariant: ["tabular-nums"] },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  sheet: { gap: space.md, paddingBottom: space.md },
  changes: { gap: space.sm, backgroundColor: colors.warnSoft, padding: space.md, borderRadius: radius.md },
});
