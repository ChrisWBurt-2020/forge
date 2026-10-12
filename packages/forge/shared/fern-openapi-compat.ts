type OpenApiObject = Record<string, unknown>;

type ParameterEntry = {
  resolved: OpenApiObject;
};

export type FernCompatibilityFixes = {
  incompatibleExamples: number;
  undiscriminatedUnionCommonProperties: number;
  mapArrayValueSchemas: number;
  streamingOperations: number;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function isRecord(value: unknown): value is OpenApiObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function child(parent: OpenApiObject | undefined, key: string): OpenApiObject | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function resolveLocalRef(document: OpenApiObject, value: unknown): OpenApiObject | undefined {
  if (!isRecord(value)) return undefined;

  const ref = value['$ref'];
  if (typeof ref !== 'string') return value;
  if (!ref.startsWith('#/')) return undefined;

  let current: unknown = document;
  for (const encodedSegment of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined;
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
}

function parameterEntries(document: OpenApiObject, owner: OpenApiObject): ParameterEntry[] {
  const parameters = owner['parameters'];
  if (!Array.isArray(parameters)) return [];

  return parameters.flatMap((value) => {
    const resolved = resolveLocalRef(document, value);
    return resolved ? [{ resolved }] : [];
  });
}

function forEachOperation(
  document: OpenApiObject,
  visitor: (
    path: string,
    pathItem: OpenApiObject,
    operation: OpenApiObject,
    method: (typeof HTTP_METHODS)[number],
  ) => void,
): void {
  const paths = child(document, 'paths');
  if (!paths) return;

  for (const [path, value] of Object.entries(paths)) {
    if (!isRecord(value)) continue;
    for (const method of HTTP_METHODS) {
      const operation = child(value, method);
      if (operation) visitor(path, value, operation, method);
    }
  }
}

function forEachRequestBodySchema(document: OpenApiObject, visitor: (schema: OpenApiObject) => void): void {
  const visited = new WeakSet<OpenApiObject>();
  const visitRequestBody = (value: unknown): void => {
    const requestBody = resolveLocalRef(document, value);
    const content = child(requestBody, 'content');
    if (!content) return;

    for (const mediaTypeValue of Object.values(content)) {
      const mediaType = isRecord(mediaTypeValue) ? mediaTypeValue : undefined;
      const schema = resolveLocalRef(document, mediaType?.['schema']);
      if (!schema || visited.has(schema)) continue;
      visited.add(schema);
      visitor(schema);
    }
  };

  const requestBodies = child(child(document, 'components'), 'requestBodies');
  if (requestBodies) {
    for (const requestBody of Object.values(requestBodies)) visitRequestBody(requestBody);
  }
  forEachOperation(document, (_path, _pathItem, operation) => visitRequestBody(operation['requestBody']));
}

function repairParameterExample(document: OpenApiObject, parameter: OpenApiObject): number {
  const schema = resolveLocalRef(document, parameter['schema']);
  const anyOf = schema?.['anyOf'];
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return 0;

  for (let refIndex = 0; refIndex < anyOf.length; refIndex++) {
    const refBranch = anyOf[refIndex];
    const literalBranch = anyOf[1 - refIndex];
    if (!isRecord(refBranch) || typeof refBranch['$ref'] !== 'string' || !isRecord(literalBranch)) continue;

    const referenced = resolveLocalRef(document, refBranch);
    const enumValues = literalBranch['enum'];
    if (
      !referenced ||
      !Object.hasOwn(referenced, 'example') ||
      Array.isArray(referenced['enum']) ||
      !Array.isArray(enumValues) ||
      enumValues.length !== 1 ||
      referenced['type'] !== literalBranch['type'] ||
      Object.is(referenced['example'], enumValues[0])
    ) {
      continue;
    }

    // Fern collapses this anyOf to its literal branch, then applies the
    // referenced branch's example to that literal. Removing the
    // documentation-only example leaves the accepted wire values unchanged.
    delete referenced['example'];
    return 1;
  }
  return 0;
}

function repairIncompatibleParameterExamples(document: OpenApiObject): number {
  let repaired = 0;
  const visited = new WeakSet<OpenApiObject>();
  const visitParameters = (owner: OpenApiObject): void => {
    for (const { resolved } of parameterEntries(document, owner)) {
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      repaired += repairParameterExample(document, resolved);
    }
  };

  const parameters = child(child(document, 'components'), 'parameters');
  if (parameters) {
    for (const parameter of Object.values(parameters)) {
      const resolved = resolveLocalRef(document, parameter);
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved);
        repaired += repairParameterExample(document, resolved);
      }
    }
  }
  forEachOperation(document, (_path, pathItem, operation) => {
    visitParameters(pathItem);
    visitParameters(operation);
  });
  return repaired;
}

function isRedundantPropertyConstraint(document: OpenApiObject, baseValue: unknown, branchValue: unknown): boolean {
  if (!isRecord(branchValue) || Object.keys(branchValue).length !== 1) return false;
  const branchType = branchValue['type'];
  if (typeof branchType !== 'string') return false;
  return resolveLocalRef(document, baseValue)?.['type'] === branchType;
}

function containsInlineNamedShape(value: unknown): boolean {
  if (!isRecord(value) || typeof value['$ref'] === 'string') return false;
  if (
    value['type'] === 'object' ||
    Array.isArray(value['enum']) ||
    Array.isArray(value['allOf']) ||
    Array.isArray(value['anyOf']) ||
    Array.isArray(value['oneOf'])
  ) {
    return true;
  }
  return value['type'] === 'array' ? containsInlineNamedShape(value['items']) : false;
}

/**
 * Fern models properties beside an undiscriminated `oneOf` as union base
 * properties. The patched TypeScript generator preserves those properties in
 * the alias, but Fern 3.80 does not emit inline declarations reachable only
 * through the base-property list. Move the common object shape into each
 * branch when branch-local duplicates add no constraints of their own.
 */
function distributeUndiscriminatedUnionProperties(document: OpenApiObject, schema: OpenApiObject): number {
  const properties = child(schema, 'properties');
  const oneOf = schema['oneOf'];
  const required = schema['required'];
  if (
    schema['type'] !== 'object' ||
    !properties ||
    Object.keys(properties).length === 0 ||
    !Object.values(properties).some(containsInlineNamedShape) ||
    !Array.isArray(oneOf) ||
    oneOf.length === 0 ||
    (required !== undefined && (!Array.isArray(required) || required.some((name) => typeof name !== 'string')))
  ) {
    return 0;
  }

  const branches: Array<{
    branch: OpenApiObject;
    properties: OpenApiObject;
    required: string[];
  }> = [];
  for (const value of oneOf) {
    if (
      !isRecord(value) ||
      value['$ref'] !== undefined ||
      value['type'] !== 'object' ||
      value['additionalProperties'] !== undefined
    ) {
      return 0;
    }
    const branchProperties = child(value, 'properties') ?? {};
    const branchRequired = value['required'];
    if (
      branchRequired !== undefined &&
      (!Array.isArray(branchRequired) || branchRequired.some((name) => typeof name !== 'string'))
    ) {
      return 0;
    }
    for (const [name, branchProperty] of Object.entries(branchProperties)) {
      if (
        Object.hasOwn(properties, name) &&
        !isRedundantPropertyConstraint(document, properties[name], branchProperty)
      ) {
        return 0;
      }
    }
    branches.push({
      branch: value,
      properties: branchProperties,
      required: (branchRequired ?? []) as string[],
    });
  }

  const commonRequired = (required ?? []) as string[];
  for (const branch of branches) {
    const uniqueBranchProperties = Object.fromEntries(
      Object.entries(branch.properties).filter(([name]) => !Object.hasOwn(properties, name)),
    );
    branch.branch['properties'] = {
      ...properties,
      ...uniqueBranchProperties,
    };
    const combinedRequired = [...new Set([...commonRequired, ...branch.required])];
    if (combinedRequired.length > 0) {
      branch.branch['required'] = combinedRequired;
    } else {
      delete branch.branch['required'];
    }
    if (schema['additionalProperties'] !== undefined) {
      branch.branch['additionalProperties'] = schema['additionalProperties'];
    }
  }

  delete schema['properties'];
  delete schema['required'];
  delete schema['additionalProperties'];
  return 1;
}

function repairUndiscriminatedUnionCommonProperties(document: OpenApiObject): number {
  let repaired = 0;
  forEachRequestBodySchema(document, (schema) => {
    repaired += distributeUndiscriminatedUnionProperties(document, schema);
  });
  return repaired;
}

function syntheticComponentName(parts: readonly string[]): string {
  const suffix = parts
    .flatMap((part) => part.split(/[^a-zA-Z0-9]+/))
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return `FernCompatibility${suffix || 'Anonymous'}`;
}

function addSyntheticComponent(document: OpenApiObject, parts: readonly string[], schema: OpenApiObject): string {
  let components = child(document, 'components');
  if (!components) {
    components = {};
    document['components'] = components;
  }
  let schemas = child(components, 'schemas');
  if (!schemas) {
    schemas = {};
    components['schemas'] = schemas;
  }

  const baseName = syntheticComponentName(parts);
  let name = baseName;
  let suffix = 2;
  while (Object.hasOwn(schemas, name)) {
    name = `${baseName}${suffix}`;
    suffix++;
  }
  schemas[name] = schema;
  return name;
}

function repairMapArrayValueSchemasIn(
  document: OpenApiObject,
  value: unknown,
  parts: readonly string[],
  visited: WeakSet<OpenApiObject>,
): number {
  const schema = resolveLocalRef(document, value);
  if (!schema || visited.has(schema)) return 0;
  visited.add(schema);

  let repaired = 0;
  const additionalProperties = schema['additionalProperties'];
  if (
    isRecord(additionalProperties) &&
    additionalProperties['$ref'] === undefined &&
    additionalProperties['type'] === 'array'
  ) {
    const items = additionalProperties['items'];
    if (
      isRecord(items) &&
      items['$ref'] === undefined &&
      (items['type'] === 'object' || child(items, 'properties') !== undefined)
    ) {
      const name = addSyntheticComponent(document, [...parts, 'map-value'], additionalProperties);
      schema['additionalProperties'] = {
        $ref: `#/components/schemas/${name}`,
      };
      repaired++;
      repaired += repairMapArrayValueSchemasIn(document, additionalProperties, [...parts, 'map-value'], visited);
    }
  }

  const properties = child(schema, 'properties');
  if (properties) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      repaired += repairMapArrayValueSchemasIn(document, propertySchema, [...parts, name], visited);
    }
  }
  if (isRecord(additionalProperties) && schema['additionalProperties'] === additionalProperties) {
    repaired += repairMapArrayValueSchemasIn(document, additionalProperties, [...parts, 'map-value'], visited);
  }
  repaired += repairMapArrayValueSchemasIn(document, schema['items'], [...parts, 'item'], visited);
  for (const composition of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[composition];
    if (!Array.isArray(branches)) continue;
    for (let index = 0; index < branches.length; index++) {
      repaired += repairMapArrayValueSchemasIn(
        document,
        branches[index],
        [...parts, composition, String(index)],
        visited,
      );
    }
  }
  return repaired;
}

/**
 * Fern 3.80 names an inline `map<string, array<object>>` declaration `Value`
 * but references it as `Item`. Lifting the complete array schema into a named
 * component keeps every array/item constraint and gives both sides one stable
 * type identity.
 */
function repairMapArrayValueSchemas(document: OpenApiObject): number {
  let repaired = 0;
  const visited = new WeakSet<OpenApiObject>();
  forEachOperation(document, (path, _pathItem, operation, method) => {
    const operationName = typeof operation['operationId'] === 'string' ? operation['operationId'] : `${method}-${path}`;
    const responses = child(operation, 'responses');
    if (!responses) return;

    for (const [status, responseValue] of Object.entries(responses)) {
      const response = resolveLocalRef(document, responseValue);
      const content = child(response, 'content');
      if (!content) continue;

      for (const [mediaType, mediaTypeValue] of Object.entries(content)) {
        const media = isRecord(mediaTypeValue) ? mediaTypeValue : undefined;
        repaired += repairMapArrayValueSchemasIn(
          document,
          media?.['schema'],
          [operationName, 'response', status, mediaType],
          visited,
        );
      }
    }
  });
  return repaired;
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/**
 * Mark operations that offer a `text/event-stream` success response for
 * Fern streaming via `x-fern-streaming`. Without the marker Fern converts
 * the endpoint as an ordinary JSON call and the streaming surface is lost
 * (the SSE content is ignored), even when the generator is configured
 * with a web stream type.
 *
 * Two shapes, mirroring how APIs actually stream:
 *
 * - The operation also returns JSON and its JSON request schema declares
 *   a boolean `stream` property (the OpenAI-style conditional pattern):
 *   emit the object form with `stream-condition: "$request.stream"`, so
 *   Fern generates a separate `<operation>Stream` method next to the
 *   regular one. The declared response schemas are reused verbatim —
 *   a spec that describes its chunks gets typed chunks; a spec that
 *   declares the stream payload as a string gets a string stream.
 * - The operation only offers the stream: emit the format-only object
 *   (unconditional streaming); the generated method returns the stream.
 *
 * Both forms set `format: "sse"` — the declared media type IS the
 * framing; Fern otherwise defaults to line-delimited JSON and the
 * generated stream parser throws on the first `data:` line. When the
 * spec's own SSE example uses the `[DONE]` sentinel, `terminator:
 * "[DONE]"` is set as well: without it the generated parser tries to
 * JSON-parse the sentinel and throws at end of stream.
 *
 * Operations that already carry `x-fern-streaming` are left untouched,
 * as are JSON operations whose request has no boolean `stream` property
 * (there is no condition to bind, and replacing their regular method
 * with a stream would be a behavior change, not a repair).
 */
function markStreamingOperations(document: OpenApiObject): number {
  let marked = 0;
  forEachOperation(document, (_path, _pathItem, operation) => {
    if (operation['x-fern-streaming'] !== undefined) return;

    const responses = child(operation, 'responses');
    if (!responses) return;

    let streamSchema: unknown;
    let hasStream = false;
    let streamTerminator: string | undefined;
    let jsonSchema: unknown;
    let hasJson = false;
    for (const status of Object.keys(responses)) {
      if (!/^2\d\d$/.test(status)) continue;
      const response = resolveLocalRef(document, responses[status]);
      const content = child(response, 'content');
      if (!content) continue;
      for (const [mediaType, mediaValue] of Object.entries(content)) {
        const media = isRecord(mediaValue) ? mediaValue : undefined;
        if (!media) continue;
        if (mediaType === 'text/event-stream') {
          hasStream = true;
          streamSchema = media['schema'] ?? { type: 'string' };
          const exampleText = JSON.stringify(
            media['example'] ?? media['examples'] ?? child(media, 'schema')?.['example'] ?? '',
          );
          if (exampleText.includes('[DONE]')) streamTerminator = '[DONE]';
        } else if (isJsonMediaType(mediaType)) {
          hasJson = true;
          jsonSchema = media['schema'];
        }
      }
    }
    if (!hasStream) return;

    if (!hasJson) {
      operation['x-fern-streaming'] = {
        format: 'sse',
        ...(streamTerminator !== undefined ? { terminator: streamTerminator } : {}),
      };
      marked++;
      return;
    }

    // Conditional form needs both a JSON response schema to fall back to
    // and a boolean `stream` request property to bind the condition to.
    if (jsonSchema === undefined) return;
    const requestBody = resolveLocalRef(document, operation['requestBody']);
    const requestContent = child(requestBody, 'content');
    if (!requestContent) return;
    let hasStreamFlag = false;
    for (const [mediaType, mediaValue] of Object.entries(requestContent)) {
      if (!isJsonMediaType(mediaType)) continue;
      const media = isRecord(mediaValue) ? mediaValue : undefined;
      const schema = resolveLocalRef(document, media?.['schema']);
      const properties = child(schema, 'properties');
      const streamProperty = resolveLocalRef(document, properties?.['stream']);
      if (streamProperty?.['type'] === 'boolean') hasStreamFlag = true;
    }
    if (!hasStreamFlag) return;

    operation['x-fern-streaming'] = {
      'stream-condition': '$request.stream',
      response: jsonSchema,
      'response-stream': streamSchema,
      format: 'sse',
      ...(streamTerminator !== undefined ? { terminator: streamTerminator } : {}),
    };
    marked++;
  });
  return marked;
}

/** Repair narrowly shaped OpenAPI constructs that Fern 5.68 cannot convert. */
export function applyFernCompatibilityFixes(openapi: object): FernCompatibilityFixes {
  const document = openapi as unknown as OpenApiObject;
  return {
    incompatibleExamples: repairIncompatibleParameterExamples(document),
    undiscriminatedUnionCommonProperties: repairUndiscriminatedUnionCommonProperties(document),
    mapArrayValueSchemas: repairMapArrayValueSchemas(document),
    streamingOperations: markStreamingOperations(document),
  };
}
