import { z } from "zod";
import {
  VerificationConfigV1Schema,
  VerificationConfigV2Schema,
  VerificationReportSchema,
} from "./index.js";

export type PublicSchemaName = "config" | "config-v1" | "config-v2" | "report";

const schemaDefinitions = {
  config: {
    schema: VerificationConfigV2Schema,
    title: "DeployWitness Configuration v2",
    id: "https://raw.githubusercontent.com/erolsenol/deploy-witness/main/schemas/config-v2.schema.json",
    io: "input",
  },
  "config-v1": {
    schema: VerificationConfigV1Schema,
    title: "DeployWitness Configuration v1",
    id: "https://raw.githubusercontent.com/erolsenol/deploy-witness/main/schemas/config-v1.schema.json",
    io: "input",
  },
  "config-v2": {
    schema: VerificationConfigV2Schema,
    title: "DeployWitness Configuration v2",
    id: "https://raw.githubusercontent.com/erolsenol/deploy-witness/main/schemas/config-v2.schema.json",
    io: "input",
  },
  report: {
    schema: VerificationReportSchema,
    title: "DeployWitness Verification Report v1",
    id: "https://raw.githubusercontent.com/erolsenol/deploy-witness/main/schemas/report-v1.schema.json",
    io: "output",
  },
} as const;

export function createPublicJsonSchema(name: PublicSchemaName): object {
  const definition = schemaDefinitions[name];
  return {
    ...z.toJSONSchema(definition.schema, {
      target: "draft-2020-12",
      io: definition.io,
    }),
    $id: definition.id,
    title: definition.title,
  };
}
