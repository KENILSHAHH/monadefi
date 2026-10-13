import { StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { colors, radius, space, type, webStyle } from "@/theme";
import { CopyButton } from "./ui";

/** A QR code on a white card, with the value below it and a copy button. */
export function AddressQr({ value, qrValue, caption }: { value: string; qrValue?: string; caption?: string }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.qr} accessibilityLabel="QR code of the address">
        <QRCode value={qrValue ?? value} size={196} backgroundColor="#FFFFFF" color="#000000" quietZone={8} />
      </View>
      {caption && <Text style={[type.small, styles.center]}>{caption}</Text>}
      <Text style={[type.mono, styles.address, webStyle({ wordBreak: "break-all" })]} selectable>
        {value}
      </Text>
      <CopyButton value={value} label="Copy address" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: space.md },
  qr: { padding: space.sm, backgroundColor: "#FFFFFF", borderRadius: radius.md },
  center: { textAlign: "center" },
  address: { textAlign: "center", color: colors.ink, fontSize: 12.5, alignSelf: "stretch" },
});
