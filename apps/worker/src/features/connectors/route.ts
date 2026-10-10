import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { validationHook } from "../../platform/validation";
import {
  ConnectorConfigMissingError,
  getConnectorSettingsView,
  InvalidConnectorConfigError,
  setTdccTrustedDevice,
  updateConnectorSettings,
} from "./service";

const settingsBodySchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

const trustedDeviceBodySchema = z.object({
  deviceId: z.string().min(1),
  devType: z.string().min(1),
  devModel: z.string().min(1).optional(),
});

export const connectorRoutes = honoFactory.createApp();
registerConnectorSettingsRoutes(connectorRoutes);

function registerConnectorSettingsRoutes(api: Hono<AppBindings>) {
  api.get("/connectors/:connectorId/settings", async (c) =>
    c.json(await getConnectorSettingsView(c.env, c.get("connectorId"))),
  );

  api.put(
    "/connectors/:connectorId/settings",
    zValidator(
      "json",
      settingsBodySchema,
      validationHook(
        "INVALID_REQUEST_BODY",
        "Request body must include a config object.",
      ),
    ),
    async (c) => {
      const body = c.req.valid("json");
      try {
        return c.json(
          await updateConnectorSettings(
            c.env,
            c.get("connectorId"),
            body.config,
          ),
        );
      } catch (error) {
        if (error instanceof ConnectorConfigMissingError) {
          return c.json(
            {
              success: false,
              error: {
                code: "CONNECTOR_CONFIG_MISSING",
                message:
                  "Cannot update public config before credentials are set.",
              },
            },
            400,
          );
        }
        if (error instanceof InvalidConnectorConfigError) {
          return c.json(
            {
              success: false,
              error: {
                code: "INVALID_CONNECTOR_CONFIG",
                message: "Connector config does not match the expected shape.",
              },
            },
            400,
          );
        }
        throw error;
      }
    },
  );

  api.post(
    "/connectors/:connectorId/trusted-device",
    zValidator(
      "json",
      trustedDeviceBodySchema,
      validationHook(
        "INVALID_REQUEST_BODY",
        "Request body must include deviceId and devType.",
      ),
    ),
    async (c) => {
      const body = c.req.valid("json");
      try {
        return c.json(
          await setTdccTrustedDevice(c.env, c.get("connectorId"), body),
        );
      } catch (error) {
        if (error instanceof ConnectorConfigMissingError) {
          return c.json(
            {
              success: false,
              error: {
                code: "CONNECTOR_CONFIG_MISSING",
                message:
                  "Set TDCC credentials before registering a trusted device.",
              },
            },
            400,
          );
        }
        if (error instanceof InvalidConnectorConfigError) {
          return c.json(
            {
              success: false,
              error: {
                code: "INVALID_CONNECTOR_CONFIG",
                message:
                  "Trusted device registration is only supported for the TDCC connector.",
              },
            },
            400,
          );
        }
        throw error;
      }
    },
  );
}
