import {
  connectorIdentityResets,
  describeConnectorSession,
  parseConnectorConfig,
} from "../../sources/config-registry";
import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/shared";
import { clearConnectorCursor } from "../../db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { findConnectorSettings, saveConnectorSettings } from "./repository";

export class ConnectorConfigMissingError extends Error {}
export class InvalidConnectorConfigError extends Error {}

export async function getConnectorSettingsView(
  env: Env,
  connectorId: ConnectorId,
) {
  const settings = await findConnectorSettings(env.DB, connectorId);
  let credentialsComplete = false;
  let sessionState = describeConnectorSession(connectorId, {}, false);
  if (settings) {
    const stored = await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    );
    credentialsComplete = connectorCatalog[connectorId].credentialFields.every(
      ({ key }) => typeof stored[key] === "string" && stored[key].length > 0,
    );
    sessionState = describeConnectorSession(
      connectorId,
      stored,
      credentialsComplete,
    );
  }
  return {
    connectorId,
    configured: Boolean(settings),
    updatedAt: settings?.updated_at,
    publicConfig: settings?.public_config
      ? filterPublicConfig(
          connectorId,
          JSON.parse(settings.public_config) as Record<string, unknown>,
        )
      : null,
    credentialsComplete,
    ...sessionState,
  };
}

export async function updateConnectorSettings(
  env: Env,
  connectorId: ConnectorId,
  rawConfig: Record<string, unknown>,
) {
  const definition = connectorCatalog[connectorId];
  const publicKeys: readonly string[] = definition.publicFields;
  const credentialKeys = definition.credentialFields.map(({ key }) => key);
  const hasSensitive = credentialKeys.some(
    (key) => rawConfig[key] !== undefined && rawConfig[key] !== "",
  );
  const now = new Date().toISOString();
  const encryptionKey = configEncryptionKey(env);
  const existing = await findConnectorSettings(env.DB, connectorId);
  if (!hasSensitive && !existing) throw new ConnectorConfigMissingError();

  let encryptedConfig: Record<string, unknown>;
  let mergedPublic: Record<string, unknown>;
  let shouldClearCursor = false;
  try {
    const storedConfig = existing
      ? await decryptJson<Record<string, unknown>>(
          existing.encrypted_config,
          encryptionKey,
        )
      : {};
    const storedPublic = existing?.public_config
      ? filterPublicConfig(
          connectorId,
          JSON.parse(existing.public_config) as Record<string, unknown>,
        )
      : {};
    const mergedConfig: Record<string, unknown> = {
      ...storedConfig,
      ...storedPublic,
      ...rawConfig,
    };
    shouldClearCursor =
      Boolean(existing) &&
      fieldsChanged(credentialKeys, storedConfig, rawConfig);
    if (shouldClearCursor) {
      for (const key of definition.resetOnCredentialChangeFields) {
        delete mergedConfig[key];
      }
      const identityReset = connectorIdentityResets[connectorId];
      if (
        identityReset &&
        fieldsChanged(identityReset.fields, storedConfig, rawConfig)
      ) {
        for (const key of identityReset.reset) delete mergedConfig[key];
      }
    }

    const parsedConfig = parseConnectorConfig(
      connectorId,
      mergedConfig,
    ) as Record<string, unknown>;
    mergedPublic = {};
    encryptedConfig = { ...parsedConfig };
    for (const key of publicKeys) {
      if (parsedConfig[key] !== undefined)
        mergedPublic[key] = parsedConfig[key];
      delete encryptedConfig[key];
    }
  } catch {
    throw new InvalidConnectorConfigError();
  }

  await saveConnectorSettings(env.DB, {
    id: existing?.id ?? crypto.randomUUID(),
    connectorId,
    encryptedConfig: await encryptJson(encryptedConfig, encryptionKey),
    publicConfig:
      Object.keys(mergedPublic).length > 0
        ? JSON.stringify(mergedPublic)
        : null,
    now,
  });
  if (shouldClearCursor) {
    await clearConnectorCursor(env.DB, connectorId, now);
  }
  return { connectorId, configured: true, updatedAt: now };
}

export async function setTdccTrustedDevice(
  env: Env,
  connectorId: ConnectorId,
  input: { deviceId: string; devType: string; devModel?: string },
) {
  // Device reuse is a TDCC-specific concept: sync trusts a device by
  // (userId, deviceId), so injecting an already-verified device id skips OTP.
  if (connectorId !== "tdcc") throw new InvalidConnectorConfigError();

  const encryptionKey = configEncryptionKey(env);
  const existing = await findConnectorSettings(env.DB, connectorId);
  if (!existing) throw new ConnectorConfigMissingError();

  const now = new Date().toISOString();
  let encryptedConfig: Record<string, unknown>;
  try {
    const stored = await decryptJson<Record<string, unknown>>(
      existing.encrypted_config,
      encryptionKey,
    );
    const credentialsComplete = connectorCatalog[
      connectorId
    ].credentialFields.every(
      ({ key }) =>
        typeof stored[key] === "string" && (stored[key] as string).length > 0,
    );
    if (!credentialsComplete) throw new ConnectorConfigMissingError();

    const merged: Record<string, unknown> = {
      ...stored,
      deviceId: input.deviceId,
      devType: input.devType,
    };
    if (input.devModel) merged.devModel = input.devModel;
    // Drop any stale session/OTP: a stored token id is bound to the previous
    // device id, so the next sync must re-login with the injected device.
    delete merged.session;
    delete merged.otp;
    delete merged.otpChannel;

    encryptedConfig = parseConnectorConfig(connectorId, merged) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (error instanceof ConnectorConfigMissingError) throw error;
    throw new InvalidConnectorConfigError();
  }

  await saveConnectorSettings(env.DB, {
    id: existing.id,
    connectorId,
    encryptedConfig: await encryptJson(encryptedConfig, encryptionKey),
    publicConfig: existing.public_config ?? null,
    now,
  });
  // The stored cursor also carries the previous device id / session; clear it
  // so the injected device id (config takes precedence) is used cleanly.
  await clearConnectorCursor(env.DB, connectorId, now);
  return { connectorId, configured: true, updatedAt: now };
}

function filterPublicConfig(
  connectorId: ConnectorId,
  config: Record<string, unknown>,
) {
  const publicKeys = connectorCatalog[connectorId].publicFields;
  return Object.fromEntries(
    publicKeys
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
}

function fieldsChanged(
  fields: readonly string[],
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  return fields.some(
    (key) =>
      key in incoming &&
      incoming[key] !== undefined &&
      incoming[key] !== "" &&
      incoming[key] !== stored[key],
  );
}
