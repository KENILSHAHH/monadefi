/**
 * Public page /fund?to=<address>. No sign-in and no passkey: it must work in the MetaMask app browser.
 * It offers only the Monad direct path (a plain transfer from MetaMask) and makes no API call.
 */
import { useLocalSearchParams } from "expo-router";
import { Text } from "react-native";
import { Destination, MonadDirect, NoMetaMask, useMetaMask } from "@/components/MetaMask";
import { Notice, Screen, SkeletonRows } from "@/components/ui";
import { parseFundTarget } from "@/lib/metamask/core";
import { type } from "@/theme";

export default function Fund() {
  const { to } = useLocalSearchParams<{ to?: string | string[] }>();
  const target = parseFundTarget(to);
  const mm = useMetaMask();

  if (!target.ok) {
    return (
      <Screen edges={["bottom"]}>
        <Text style={type.title}>Deposit to Mona-DeFi</Text>
        <Notice tone="bad">{target.error}</Notice>
      </Screen>
    );
  }

  return (
    <Screen edges={["bottom"]}>
      <Text style={type.title}>Deposit to Mona-DeFi</Text>
      <Destination address={target.address} title="Deposit to your Mona-DeFi wallet" warn />
      {mm.status === "searching" && <SkeletonRows rows={1} />}
      {mm.status === "missing" && <NoMetaMask to={target.address} onRetry={mm.retry} />}
      {mm.status === "found" && <MonadDirect provider={mm.provider} to={target.address} />}
      <Text style={type.tiny}>Only Monad (chain 143). MetaMask asks you to confirm one plain transfer to the address above. It signs nothing else.</Text>
    </Screen>
  );
}
