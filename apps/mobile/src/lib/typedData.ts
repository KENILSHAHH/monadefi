import type { TypedDataPayload } from "./api/types";

type Field = { name: string; type: string };

const INT = /^u?int(\d*)$/;

/**
 * The server sends uint256 values (for example the delegation salt) as decimal strings, because JSON has no bigint.
 * viem hashes integers from bigint or number. This converts every integer field of the typed data to bigint,
 * walking structs and arrays by the declared types, so the hash is exactly the one the server checks.
 */
export function normalizeTypedData(td: TypedDataPayload): TypedDataPayload {
  const types = td.types;

  const convert = (type: string, value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    const arr = /^(.*)\[(\d*)\]$/.exec(type);
    if (arr) return Array.isArray(value) ? value.map((v) => convert(arr[1]!, v)) : value;
    if (INT.test(type)) {
      if (typeof value === "bigint") return value;
      if (typeof value === "number") return BigInt(value);
      if (typeof value === "string" && /^-?(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
      return value;
    }
    const fields = types[type];
    if (fields && typeof value === "object") return struct(fields, value as Record<string, unknown>);
    return value;
  };

  const struct = (fields: Field[], obj: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...obj };
    for (const f of fields) if (f.name in obj) out[f.name] = convert(f.type, obj[f.name]);
    return out;
  };

  const domainFields = types.EIP712Domain;
  const domain = domainFields ? struct(domainFields, td.domain) : { ...td.domain };
  if (typeof domain.chainId === "string" && /^\d+$/.test(domain.chainId)) domain.chainId = Number(domain.chainId);
  const primary = types[td.primaryType];
  const message = primary ? struct(primary, td.message) : td.message;
  return { ...td, domain, message };
}
