/** Renders an agent reply (Markdown) with the app theme. See lib/markdown.ts for the parser. */
import { memo, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { colors, fonts, radius, space, type } from "@/theme";
import { openLink } from "./ui";


function Spans({ inline, base }: { inline: Inline[]; base?: TextStyle }) {
  return (
    <>
      {inline.map((x, i) => {
        if (x.t === "code") return <Text key={i} style={styles.code}>{x.text}</Text>;
        const st: TextStyle[] = [];
        if (base) st.push(base);
        if (x.bold) st.push(styles.bold);
        if (x.italic) st.push(styles.italic);
        if (x.t === "link") {
          return (
            <Text key={i} style={[...st, styles.link]} onPress={() => openLink(x.url)} accessibilityRole="link">
              {x.text}
            </Text>
          );
        }
        return <Text key={i} style={st}>{x.text}</Text>;
      })}
    </>
  );
}

function BlockView({ b, index }: { b: Block; index: number }) {
  switch (b.t) {
    case "p":
      return (
        <Text style={styles.text} selectable>
          <Spans inline={b.inline} />
        </Text>
      );
    case "h":
      // Headings are bold body text, not large titles.
      return (
        <Text style={[styles.text, styles.bold, index > 0 && styles.headTop]} selectable accessibilityRole="header">
          <Spans inline={b.inline} />
        </Text>
      );
    case "li":
      return (
        <View style={[styles.li, { paddingLeft: b.depth * space.lg }]}>
          <Text style={[styles.text, styles.bullet]}>{b.ordered ? `${b.n}.` : "•"}</Text>
          <Text style={[styles.text, styles.flex]} selectable>
            <Spans inline={b.inline} />
          </Text>
        </View>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <Text style={[styles.text, { color: colors.dim }]} selectable>
            <Spans inline={b.inline} />
          </Text>
        </View>
      );
    case "code":
      return (
        <ScrollView horizontal style={styles.codeBlock} contentContainerStyle={styles.codeInner}>
          <Text style={styles.codeText} selectable>
            {b.text}
          </Text>
        </ScrollView>
      );
    case "hr":
      return <View style={styles.hr} />;
    case "table":
      return (
        <ScrollView horizontal style={styles.table} contentContainerStyle={styles.tableInner}>
          <View>
            <View style={[styles.row, styles.headRow]}>
              {b.header.map((c, i) => (
                <Text key={i} style={[styles.cell, styles.bold]}>
                  <Spans inline={c} />
                </Text>
              ))}
            </View>
            {b.rows.map((r, ri) => (
              <View key={ri} style={[styles.row, ri < b.rows.length - 1 && styles.rowLine]}>
                {b.header.map((_, ci) => (
                  <Text key={ci} style={styles.cell}>
                    <Spans inline={r[ci] ?? []} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
}

/** Markdown text. Safe while it streams: an unclosed "**" never shows. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} index={i} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { gap: space.sm },
  // Numbers (AUSD amounts, prices) line up: tabular figures.
  text: { ...type.body, lineHeight: 22, fontVariant: ["tabular-nums"] },
  bold: { ...fonts.sansBold },
  italic: { fontStyle: "italic" },
  link: { color: colors.accent, textDecorationLine: "underline" },
  headTop: { marginTop: space.xs },
  code: { ...fonts.mono, fontSize: 13, color: colors.ink, backgroundColor: colors.raised },
  codeBlock: { backgroundColor: colors.raised, borderRadius: radius.sm },
  codeInner: { padding: space.md },
  codeText: { ...fonts.mono, fontSize: 12, color: colors.ink, lineHeight: 18 },
  li: { flexDirection: "row", gap: space.sm },
  bullet: { minWidth: 16, color: colors.dim },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: space.md },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.xs },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.sm },
  tableInner: { flexGrow: 1 },
  row: { flexDirection: "row" },
  headRow: { backgroundColor: "rgba(255,255,255,0.06)", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  cell: { ...type.small, color: colors.ink, fontVariant: ["tabular-nums"], minWidth: 84, maxWidth: 180, paddingHorizontal: space.sm, paddingVertical: 6 },
});
