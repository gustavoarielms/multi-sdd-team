# Issue #13 — prueba acotada de calidad y remediación

## Estado y decisiones aprobadas

Esta especificación define la Fase B de la issue #13 sobre el árbol base
`13f578fd62c8a35276f3069822ff9714e7160782`. Su propósito es demostrar el
circuito completo de gates deterministas y remediación como evidencia candidata
para v0.4.0. No autoriza publicación, release, merge, cambios de consumidores
ni cambios de settings.

Quedan aprobadas estas decisiones de alcance:

- La prueba es un *harness* acotado; no se incorpora un scheduler de runtime,
  un motor de persistencia ni un bloqueo técnico general para toda sesión.
- Se corrige el resultado `engineering-gate-run` a versión `1.1.0` para
  conservar evidencia informativa de cobertura unit e integration. Los
  umbrales, efectos y reglas bloqueantes existentes no cambian.
- Un resultado `1.0.0` continúa siendo válido como documento histórico, pero
  nunca acredita por sí solo la elegibilidad de #13. `validate-result` sigue
  validando únicamente documentos de agentes; no es una aprobación del
  circuito.
- El expediente se genera fuera del target y fuera del código versionado. Sus
  hashes prueban integridad de archivos, no autoría ni que una ejecución haya
  ocurrido. Esas dos propiedades se sostienen mediante la observación de la
  ejecución real y los handoffs de los mismos agentes de la cadena SDD.
- `GOV-REMEDIATION-LOOP-001` conserva su efecto actual `warn`; no se cambia
  ninguna otra política ni se crean APIs públicas si un script standalone es
  suficiente.

## Especificación funcional

### Alcance y objetivos

La entrega debe cerrar dos brechas verificables.

1. El resultado de coverage combina hoy los mapas unit e integration y solo
   publica `coverage_global` y `coverage_changed`. Debe además conservar los
   conteos por suite como evidencia observada, sin convertirlos en nuevos
   controles.
2. Debe existir una prueba reproducible de un expediente de remediación:
   hallazgo real de un reviewer, retorno al implementer, corrección, nueva
   ejecución de todos los gates, y revalidación por el reviewer que originó el
   hallazgo. El expediente debe rechazar intentos de declarar elegible una
   secuencia incompleta o inconsistente.

El target de la demostración es un clon aislado del paquete completo
materializado desde el SHA base más el snapshot dirty del candidato, incluidos
los cambios autorizados y archivos nuevos. Conserva el historial y la base de
comparación, y ejecuta código y suites reales. La mutación demostrativa es una
violación arquitectónica real `production -> test`: por ejemplo, una función de
`src/` importa un helper de `test/`, mientras un test conductual permanece
verde y el coverage íntegro. La corrección del implementer elimina esa
dependencia prohibida y conserva conducta y test. La mutación se rastrea en un
índice temporal sin commits. No se reemplazan las suites por stubs: el paquete
completo debe poder satisfacer su coverage global con sus propias pruebas.

El harness queda fuera de `npm test` y fuera de `run-gates`; se invoca mediante
un script standalone. Sus helpers y casos negativos se prueban dentro de las
suites existentes. Esta separación evita la recursión `run-gates -> tests ->
run-gates` y conserva la invocación canónica de los diez gates.

### Criterios de aceptación

| ID | Criterio verificable |
|---|---|
| AC-01 | Para una ejecución coverage con estado `pass` o `fail`, el resultado 1.1.0 contiene, en este orden, `coverage_global`, `coverage_changed`, `coverage_unit` y `coverage_integration`. |
| AC-02 | `coverage_unit` y `coverage_integration` son evidencia auxiliar con `kind: test_result`, `level: deterministic`, `outcome: observed` y conteos exactos `covered/total` de lines, branches, functions y statements. No se usan porcentajes redondeados para decidir. |
| AC-03 | Las dos evidencias auxiliares no crean checks, reglas, umbrales ni efectos nuevos; `coverage_global` y `coverage_changed` siguen siendo los únicos subresultados de coverage y conservan sus efectos actuales. |
| AC-04 | Si coverage termina en `error` o `not_run`, ambas evidencias auxiliares están prohibidas. Si es `pass` o `fail`, ambas son obligatorias, únicas y propias del executor coverage. Tests del productor con mapas por suite distintos acreditan la correspondencia de sus conteos. |
| AC-05 | El consumidor/validador distingue `engineering-gate-run` 1.0.0 y 1.1.0: acepta la estructura histórica 1.0.0 y exige la nueva forma para 1.1.0, sin cambiar `common.schema.json` ni `evidence.schema.json` 1.0.0. |
| AC-06 | El harness ejecuta gates reales contra el mismo snapshot efectivo desde source, instalación local, instalación global y tarball packed consumer. Compara resultados semánticos dentro de cada versión de Node; excluye únicamente `run_id`, timestamps, duraciones y los summaries/conteos instrumentales de `coverage_global`, `coverage_changed`, `coverage_unit` y `coverage_integration` en evidence/checks. Cada captura debe validar independientemente sus diez gates en pass y conservar outcomes, statuses, reason codes, IDs, orden, gate effects y toda otra semántica. |
| AC-07 | El caso positivo contiene una violación arquitectónica real `production -> test` con pruebas conductuales verdes y coverage íntegro, un finding de un reviewer real, un handoff al implementer, una corrección limitada al fixture que elimina la dependencia y conserva conducta/test, una nueva corrida completa de gates y una revalidación real por el reviewer originador. La identidad técnica del productor sigue siendo el rol; la continuidad de la instancia se conserva operativamente mediante `followup` al mismo subagent. |
| AC-08 | La comprobación determinista del expediente rechaza evidencia ausente, modificada, de un snapshot distinto, previa a la corrección, de orden inválido, de un reviewer lógico distinto o sin revalidación. Un último JSON verde aislado no basta. |
| AC-09 | La identidad del snapshot efectivo incluye SHA base y un digest que cubre tracked, untracked no ignorados, borrados y modos, incluyendo cambios dirty del fixture. |
| AC-10 | Los artefactos del expediente son archivos regulares contenidos bajo su raíz, con rutas relativas, campos allowlisted y SHA-256. No contienen logs crudos, secretos, credenciales, variables de entorno ni datos de setup/cache/prefix. |
| AC-11 | CI ejecuta el perfil completo de gates en Node 22.14.0 y 24.19.0. Conserva los nombres de checks actuales, validación JSON/TOML, `git diff --check` y las guardas de release/publicación existentes. |
| AC-12 | La ejecución mantiene los límites existentes: filesystem quiescent durante cada corrida y el residual aceptado de procesos detached/reparented; no afirma detectarlos ni intenta repararlos. |

### Casos de uso

**Caso positivo: remediación completa.** El harness materializa el paquete
completo desde SHA base más el snapshot dirty del candidato, realiza la
mutación arquitectónica controlada `production -> test` y ejecuta `run-gates`
con su base explícita. La violación produce `fail` con pruebas conductuales
verdes y coverage íntegro. El orquestador obtiene de un reviewer real el
finding sobre ese estado. El implementer elimina solamente la dependencia
prohibida del fixture y conserva conducta/test. El harness repite todos los
gates contra el nuevo snapshot efectivo; el orquestador entrega esos resultados
al reviewer originador para su revalidación. Solo entonces el manifiesto puede
declarar el expediente elegible para aprobación humana. Esa declaración no
autoriza merge ni release.

**Caso negativo: fallo funcional.** Una violación confiable devuelve `fail` y
preserva la ejecución de los gates posteriores. Produce outcome agregado
`failed` con salida `1` solo si no existe `run_error`, `error` ni `not_run` en
la corrida. El expediente no puede avanzar a elegibilidad y requiere retorno
al implementer, nueva ejecución de gates y revalidación del reviewer originador.

**Caso negativo: evaluación incompleta.** Un `run_error`, `error` o `not_run`
domina cualquier `fail`: un `error` detiene los ejecutores posteriores como
`not_run` y la corrida genera `blocked` con salida `2`. Un caso de assertion
fallida que termine además en `coverage error` conserva `blocked`/`2`; no se
cambia el runtime para acomodar el harness. El expediente no puede avanzar y
requiere remediación, nueva ejecución completa y revalidación del reviewer
originador.

**Caso negativo: evidencia adulterada o ajena.** Cambiar bytes después de
registrar su hash, referenciar una ruta fuera del expediente, usar un symlink,
omitir un artefacto, reutilizar un gate anterior, o enlazar un reviewer lógico
distinto hace fallar la verificación del expediente.

## Especificación técnica

### Componentes propuestos

1. **Productor de coverage 1.1.0.** `collectCoverageMaps` conserva mapas unit
   e integration, además de su combinación actual. La evaluación construye
   conteos normalizados exactos para cada suite y los adjunta como evidencia
   `observed`; global y changed continúan calculándose sobre el mapa combinado.

2. **Contrato y validador versionados.** El schema específico de
   `engineering-gate-run` y su carga/validación enrutan por versión: 1.0.0
   conserva exactamente sus dos evidencias actuales; 1.1.0 permite y exige las
   cuatro evidencias en el orden fijado. No se modifica el schema common ni el
   de evidence para representar esta evolución específica del resultado.

3. **Validador semántico de coverage.** Para 1.1.0 verifica orden, unicidad,
   pertenencia al executor, forma de los conteos declarados y la unión de
   evidencia esperada. También verifica que el union de los checks siga siendo
   solo global y changed; las observaciones auxiliares no entran en
   `result.checks` ni alteran su `gate_effect`. No puede probar que valores
   plausibles no hayan sido intercambiados: esa correspondencia por suite se
   acredita con tests del productor que usen mapas unit e integration distintos.

4. **Harness standalone y verificador de expediente.** Ambos viven como
   herramientas internas del paquete, sin API pública. El harness crea y
   destruye sus temporales fuera del workspace original, captura snapshots y
   gates, y verifica el expediente por fases. No fabrica handoffs ni invoca
   herramientas de colaboración: el orquestador obtiene los reviews y la
   corrección reales, mantiene al subagent originador con `followup` y entrega
   esos handoffs al expediente. Los casos de helpers van en las suites
   unit/integration existentes.

5. **CI de compatibilidad.** El perfil completo se ejecuta sobre el candidato
   en ambas versiones de Node. Puede compartirse evidencia de una misma
   ejecución entre comprobaciones que refieran exactamente al mismo artefacto;
   no se simulan pases ni se reutilizan resultados de un snapshot diferente.

### Contratos

#### `engineering-gate-run` 1.1.0

El envelope conserva todos los campos existentes. La evolución se limita al
array `evidence` del executor `coverage`:

```text
coverage_global       check bloqueante existente
coverage_changed      check bloqueante existente o not_applicable
coverage_unit         observación informativa obligatoria en pass/fail
coverage_integration  observación informativa obligatoria en pass/fail
```

Las observaciones usan el formato de resumen vigente, por ejemplo
`lines 85/100, branches 40/50, functions 17/20, statements 90/105`. Su
`outcome` es siempre `observed`; no hereda `pass` ni `fail` de los umbrales.
La decisión continúa usando las fracciones exactas que ya evalúa el adapter.

El resultado 1.0.0 se acepta para lectura histórica conforme a su contrato
anterior. El resultado 1.1.0 debe ser el producido para la prueba de #13. Un
validador antiguo puede rechazar 1.1.0: productor y validador de la prueba se
actualizan juntos y no hacen downgrade automático.

#### Expediente externo de remediación

El manifiesto es un JSON externo con una lista cerrada de artefactos. Cada
entrada contiene únicamente: identificador, tipo permitido, ruta relativa,
SHA-256, snapshot efectivo asociado y referencias permitidas a finding,
handoff, gate-run o revalidación. El verificador exige que cada ruta:

- permanezca debajo de la raíz del expediente tras normalización y realpath;
- sea un archivo regular, no un symlink;
- exista, tenga el digest declarado y un tamaño dentro del límite definido por
  el harness; y
- sea una referencia única y necesaria para la secuencia.

El snapshot efectivo se representa por el SHA de comparación y un digest
canónico de inventario. El inventario incluye el contenido y modo de archivos
tracked, cambios staged/unstaged, borrados y archivos untracked no ignorados;
usa rutas normalizadas y no almacena el contenido en el manifiesto. Cambiar
cualquiera de esos elementos produce un digest diferente. El digest detecta
diferencias observables, pero no autentica a quien fabricó el inventario.

La cadena mínima de referencias es:

```text
snapshot inicial -> gates con fallo -> finding del reviewer
-> handoff al implementer -> snapshot corregido -> gates completos nuevos
-> revalidación del reviewer originador -> decisión de elegibilidad humana
```

El `producer.id` de `agent-result` identifica un rol fijo y no una instancia
de agente. Por eso el manifiesto comprueba el reviewer lógico y la continuidad
de las referencias; la identidad de la misma instancia no se agrega al
contrato `agent-result`. La ejecución SDD debe enviar la revalidación como
follow-up al mismo subagent que produjo el finding, y la observación de esa
cadena se conserva como evidencia externa normalizada. El verificador no
autentica autoría ni procedencia; tampoco lo hacen hashes que un atacante
coherente pueda recalcular junto con los artefactos.

### Semántica de gates y elegibilidad

La invocación canónica permanece `sdd-codegraph run-gates [target]
--comparison-base <sha-completo>`. Debe incluir los diez ejecutores registrados
en el perfil y no omitir controles por causa del harness.

| Estado del executor | Efecto de ejecución | Resultado agregado / salida | Elegibilidad |
|---|---|---|---|
| `pass` | Continúa. | Puede ser `passed` / 0 si todos pasan y no hay incompletitud. | Solo tras expediente completo y revalidación. |
| `fail` | Continúan los gates posteriores para reunir hallazgos. | `failed` / 1 solo si no hay `run_error`, `error` ni `not_run`; de otro modo domina `blocked` / 2. | Rechazada; requiere remediación y revalidación. |
| `error` | Detiene los posteriores, que quedan `not_run`. | `blocked` / 2, aun si otro executor ya devolvió `fail`. | Rechazada; requiere remediación y revalidación. |
| `not_run` | Indica evaluación incompleta. | `blocked` / 2, aun si existe `fail`. | Rechazada; requiere remediación y revalidación. |

El verificador del expediente no interpreta un JSON schema-válido como un pase
de gates ni como aprobación. Solo evalúa la completitud e integridad de la
evidencia contra esta secuencia. La aprobación final sigue siendo humana.

### Distribución, compatibilidad y CI

El harness usa el mismo target/snapshot para cuatro lanzadores reales:

1. source checkout;
2. instalación local;
3. instalación global;
4. consumidor creado desde `npm pack`.

Todos ejecutan el CLI instalado correspondiente contra el mismo fixture y con
la misma base explícita. La comparación se hace dentro de cada versión de
Node: exige equivalencia de outcome, exit code, executor IDs/orden, estados,
gate effects, reason codes, check IDs, evidence IDs y toda otra semántica. Sólo
excluye `run_id`, timestamps, `duration_ms` y los summaries/conteos
instrumentales de `coverage_global`, `coverage_changed`, `coverage_unit` y
`coverage_integration` en evidence/checks; cada layout debe validar por separado
los diez gates y sus thresholds de coverage en pass. Entre Node 22 y Node 24 no
se exige igualdad de conteos instrumentales propios de V8. Las rutas de setup, cache o
prefix solo pueden aparecer en evidencia externa del harness, nunca en el
resultado canónico ni en artefactos expuestos.

La matriz CI mantiene sus nombres de jobs actuales. Ejecuta el perfil completo
de gates en Node 22.14.0 y conserva la ejecución ya existente del job Policy
and package en Node 24.19.0, sin repetir innecesariamente tres corridas
completas en Node 24. El job de política conserva sus pasos de JSON/TOML, `git
diff --check`, environment sanitizado y guardas de publish/release. CI acredita
la mecánica, compatibilidad y layouts; no se atribuye reviews humanos reales ni
puede fabricar sus handoffs. La implementación debe evitar una segunda cadena
recursiva de suites o un costo duplicado no justificado.

### Riesgos y límites aceptados

| Riesgo | Tratamiento |
|---|---|
| Una suite mínima/stub permitiría un falso pase de coverage global. | El fixture es un clon del paquete completo y ejecuta pruebas reales; el harness no sustituye suites. |
| La identidad de `producer.id` parece identificar una instancia. | Se documenta como rol fijo; la misma instancia se mantiene por follow-up real, sin alterar `agent-result`. |
| Hashes se interpretan como prueba de autoría. | El manifiesto declara el límite: integridad solamente; un atacante coherente puede recalcularlos. La observación de la ejecución y handoffs aporta procedencia operativa. |
| Evidencia sensible o demasiado grande. | Allowlist, resúmenes normalizados, límites de tamaño, archivos regulares contenidos y prohibición de logs crudos/secretos. |
| Cambios concurrentes invalidan la medición. | Cada gate conserva su precondición de filesystem quiescent; el digest de snapshot detecta diferencias observables entre etapas. |
| Procesos detached/reparented. | Se conserva el residual previamente aceptado; no se promete cleanup fuera de la atribución actual. |

### Plan de implementación y verificación

1. Agregar pruebas rojas del contrato 1.1.0: presencia, orden, unicidad,
   ausencia en `error`/`not_run`, conteos exactos, lectura histórica 1.0.0 y
   rechazo de mezcla/omisión. Añadir mapas unit e integration deliberadamente
   distintos para acreditar que el productor no intercambia sus conteos. Cubrir
   además la precedencia: todo `run_error`, `error` o `not_run` domina un
   `fail` y devuelve `blocked`/`2`.
2. Cambiar el productor y el validador específico para soportar las dos
   versiones, manteniendo los checks, umbrales y efectos de coverage.
3. Agregar helpers del manifiesto y sus pruebas negativas: ruta escapada,
   symlink, hash alterado, artefacto faltante, snapshot mismatch, evidencia
   vieja/nueva indebida, orden de transición inválido, reviewer lógico distinto
   y falta de revalidación.
4. Implementar el script standalone que materializa el fixture completo desde
   HEAD base más el snapshot dirty del candidato, captura snapshots y gates, y
   verifica el expediente por fases. La mutación inicial debe ser una
   dependencia arquitectónica real `src -> test` con test conductual verde y
   coverage íntegro; la corrección elimina esa dependencia y conserva ambos.
   Debe conservar todos los controles del fixture y no escribir en el workspace
   original. El orquestador, no el harness, obtiene el finding, handoff,
   corrección y revalidación reales y los aporta al expediente.
5. Ejecutar la comparación source/local/global/tarball dentro de cada versión
   de Node y la matriz de Node 22.14.0/24.19.0 contra el candidato; registrar
   solo evidencia acotada. Reutilizar la corrida exacta ya realizada por Policy
   and package en Node 24 cuando corresponda.
6. Ejecutar estrictamente en secuencia, sin agentes ni trabajo local en
   paralelo: arquitectura de diseño, seguridad del contrato/evidencia,
   implementación TDD, gates deterministas, arquitectura de cumplimiento,
   seguridad final y calidad. Todo hallazgo Blocker/Required vuelve al
   implementer; después se repiten gates y revalida el reviewer que lo originó.
   Las instrucciones instaladas pueden aclarar invocación e interpretación,
   pero no cambiar la política aprobada.

## Decisiones no abiertas

No queda una alternativa material pendiente para comenzar. La futura
implementación puede elegir nombres internos y ubicación exacta de los
scripts/fixtures siempre que respete estos contratos, no exponga una API nueva
y mantenga el cambio mínimo. Cualquier propuesta de elevar una regla `warn`,
crear persistencia/scheduler, cambiar el contrato común de evidencia o ampliar
el expediente a datos sensibles requiere una nueva aprobación explícita.

## Uso del harness implementado

El entrypoint interno es `scripts/quality-proof.js`; no forma parte de `npm
 test` ni de `run-gates`. Requiere dos ejecutables confiables de Node 22.14.0 y
24.19.0 con npm junto al binario, y un directorio de trabajo **nuevo**, fuera
del candidato. No descarga runtimes. Todos sus subprocesses reciben un
entorno permitido explícito sin controles Node/c8/ESLint heredados. El proceso
principal también debe iniciarse con esos controles eliminados, como en CI.
Cada instalación usa archivos `user.npmrc` y `global.npmrc` vacíos, distintos y
privados dentro del cache owned; el harness los valida antes de cada uso y no
publica esas rutas en el expediente.

```sh
# Rutas explícitas a runtimes previamente verificados y a un directorio nuevo.
PROOF_NODE22=/path/to/node22/bin/node
PROOF_NODE24=/path/to/node24/bin/node
PROOF_WORK=/path/outside/candidate/issue13-proof
PROOF_BASE=13f578fd62c8a35276f3069822ff9714e7160782

# Aplicar este prefijo env a cada invocación del script.
env -u C8_CONFIG -u C8_REPORTER -u NODE_OPTIONS -u NODE_PATH \
  -u NODE_V8_COVERAGE -u NYC_CONFIG -u TIMING -u DEBUG -u ESLINT_FLAGS \
  "$PROOF_NODE22" scripts/quality-proof.js prepare . "$PROOF_WORK" "$PROOF_BASE"

"$PROOF_NODE22" scripts/quality-proof.js initial "$PROOF_WORK" "$PROOF_NODE22"
# STOP: obtener reviewer e implementer reales antes de continuar.
"$PROOF_NODE22" scripts/quality-proof.js matrix "$PROOF_WORK" "$PROOF_NODE22" "$PROOF_NODE24"
# STOP: pedir revalidación al mismo subagent reviewer mediante follow-up.
"$PROOF_NODE22" scripts/quality-proof.js assemble "$PROOF_WORK"
"$PROOF_NODE22" scripts/quality-proof.js verify "$PROOF_WORK/dossier"
```

`prepare` clona el historial local, superpone el snapshot dirty del candidato
(incluidos archivos nuevos, borrados y modos) y comprueba su identidad antes de
mutar la fixture. La mutación agrega a `src/node-test-reporter.js` una función
que depende de `test/issue13-remediation-helper.js`, junto con una prueba
conductual en el wrapper de integración existente. Esta ubicación evita que
la importación rompa anticipadamente los smoke tests del CLI packed. El índice
normal del clon registra mediante intent-to-add únicamente los untracked no
ignorados del snapshot candidato y el helper de la demo. Las altas que ya
estaban staged se reproducen sólo en el índice del clon con
`git update-index --add -- <paths-exactos>`, después de comprobar sus bytes y
modo contra el inventario; esto incluye una alta staged forzada bajo ignore.
Los demás cambios y borrados tracked ya son visibles. Las listas se capturan
antes de copiar con consultas Git NUL y se validan contra el inventario. No se
crean commits y no se usa `-f`, `--all` ni `GIT_INDEX_FILE`. Instala dependencias con `npm ci
--ignore-scripts`, sin ejecutar hooks del target.

Antes de crear el workspace o ejecutar comandos, resuelve su padre existente
con realpath y exige un destino físico nuevo fuera del candidato. También
exige reporter y wrapper regulares, helper ausente (incluso un symlink roto se
rechaza) y padres no simbólicos para esas tres rutas. Repite ese preflight en
el clon antes de las tres mutaciones. Los append usan `O_NOFOLLOW`; sin soporte
para esa apertura se rechaza la preparación. Los demás symlinks siguen siendo
contenido literal del inventario y de la copia, sin ser dereferenciados.

`initial` conserva un resultado canónico válido, incluso si está bloqueado;
la demostración espera salida **1**, exclusivamente por la violación
arquitectónica, y todos los demás ejecutores en pass. Un resultado incompleto
no puede cerrar el expediente. El script no corrige la fixture ni fabrica
resultados de agentes.

El orquestador debe aportar, sin reserializar ni alterar su contenido, estos
JSON de agentes reales bajo `dossier/`:

- `review.json`: `architecture_reviewer`, un finding abierto/verificado para
  `ARCH-PROD-NO-TEST-001`, gate fail y handoff al implementer que incluye el
  finding pendiente.
- `implementation.json`: resultado real del implementer tras corregir el
  clon `target/`, `parent_run_id` del review y handoff al reviewer originador.
  La corrección elimina la dependencia de producción al helper de tests y
  mantiene la función y su prueba conductual. No se alteran controles.
- `revalidation.json`: mismo rol y misma instancia por follow-up operativo,
  `parent_run_id` del review inicial, mismo finding ID/fingerprint/regla con
  estado resolved y validación verified, gate pass, sin blockers pendientes.

Los handoffs deben incluir estas evidencias **al ser emitidos**, usando los
campos existentes de `agent-result`; el assembler nunca las agrega ni modifica:

| Handoff | `evidence_id` | `artifact.uri` literal | `artifact.sha256` |
|---|---|---|---|
| review | `evidence:proof-initial` | `initial.json` | SHA256 de los bytes exactos de `initial.json` |
| implementation | `evidence:proof-review` | `review.json` | SHA256 de los bytes exactos del review recibido |
| implementation | `evidence:proof-corrected-snapshot` | `urn:multi-sdd:quality-proof:corrected-snapshot` | Digest del inventario corregido, sin el prefijo `sha256:` |
| revalidation | `evidence:proof-final` | `final.json` | SHA256 de los bytes exactos de la matriz recibida |

Cada evidencia utiliza `schema_version: "1.0.0"`, `kind: "document"`,
`level: "observed"`, `outcome: "observed"` y
`artifact.media_type: "application/json"`, junto con los campos normales
summary/collected_at/collected_by/redaction del contrato. Estos resultados
observados no sustituyen los findings ni las decisiones de gate del reviewer.
El `collected_at` del enlace debe estar dentro del intervalo started_at/completed_at
del handoff; en particular, la observación del implementer precede a la matriz.
Los IDs `evidence:proof-initial` y `evidence:proof-final` deben figurar en
`finding.evidence_ids` y en **cada** gate required que evalúe
`ARCH-PROD-NO-TEST-001`; ese gate también debe incluir el finding ID.
Debe existir al menos un gate required para esa regla. Ninguna decisión
required del review inicial puede estar blocked/not_run; todas las decisiones
required de revalidación y del implementer deben estar pass. El contrato de
agent-result representa los errores de evaluación como blocked.

El implementer obtiene el digest corregido con `captureSnapshot(target, base)`
de `src/quality-proof.js`, después de su corrección y antes de la matriz. La
URN es un identificador fijo no dereferenciable: su sha256 es el hash del
inventario normalizado, **no** el hash de un archivo ubicado en esa URI. El
verificador lo compara exactamente con el snapshot de las ocho capturas
finales y exige que difiera del inicial. No se crea un sexto artefacto.
Las otras tres referencias se comparan con los bytes ya cargados de los
archivos fijos del expediente; cambiar una captura requiere nuevos handoffs
que la hayan observado. Ninguna URI se ejecuta o dereferencia.

Los run IDs deben ser únicos y los timestamps deben respetar la secuencia:
initial → review → implementación → ocho capturas nuevas → revalidación.
El reviewer recibe el snapshot y los artefactos que revisa; el manifiesto
los vincula sin modificar los JSON originales. Los hashes no autentican estas
atribuciones. El orquestador sigue siendo responsable de observar las acciones
reales, conservar la misma instancia y comprobar que los reportes no incluyan
secretos, logs crudos ni rutas privadas de setup/cache. No se aplican cambios o
redacciones silenciosas a un handoff recibido.

`matrix` requiere los dos primeros handoffs. Usa el mismo target corregido y
captura source/local/global/packed por cada Node. Local/global se instalan desde
el directorio con `--install-links`; packed se instala desde un tarball real.
Los prefixes y caches quedan en el workspace privado. Cada invocación registra
snapshot antes/después y el código de salida real; no reusa una captura de un
snapshot anterior. La versión de Node, los ocho layouts y su orden se comprueban
al verificar. Dentro de cada Node se comparan outcomes, statuses, reason codes,
IDs, orden, gate effects y toda otra semántica; solo se excluyen run IDs,
timestamps, duraciones y los summaries/conteos instrumentales de los cuatro
resultados coverage en evidence/checks. Cada captura conserva validación
independiente y exige sus diez gates en pass. Entre Node 22 y 24 no se exige
igualdad de conteos instrumentales. La equivalencia se valida después de
conservar las ocho capturas privadas y antes de escribir `dossier/final.json` o
anunciar `final_matrix_captured`; un mismatch falla cerrado sin publicar ese
artefacto final.

Cada captura válida de la matriz se conserva además como
`launchers-*/capture-<node-index>-<layout>.json` en el intento privado, incluso
si un gate falla y no se completa `final.json`. No se guardan logs crudos ni se
añaden artefactos al dossier; una captura incompleta nunca otorga elegibilidad.

`assemble` exige exactamente cinco artefactos: `initial.json`, `review.json`,
`implementation.json`, `final.json` (ocho capturas) y `revalidation.json`.
Escribe `manifest.json` una sola vez y verifica integridad y secuencia. No
sobrescribe evidencia existente. Una prueba con solo source no es elegible.
El resultado positivo exige aprobación humana y nunca autoriza merge/release.

Los límites son: manifiesto 16 KiB; cada artefacto 2 MiB; expediente 8 MiB
(reservando 16 KiB para el manifiesto); profundidad JSON 32 y colecciones 4096.
Se verifican tamaño total y tipo de archivos antes de leer/parsear/hash; se
rechazan rutas no canónicas, symlinks en hojas o padres, archivos especiales y
aliases físicos/hardlinks. No se dereferencia `artifact.uri`: es metadata.
Para snapshots del target se admiten symlinks como modo `120000` más el hash
del destino **literal**; no se lee su contenido externo y la copia recrea el
link. Los padres simbólicos siguen rechazados. El límite del inventario es
5000 rutas, 16 MiB por archivo y 64 MiB en total.

El workspace original nunca se modifica. El clon, prefixes y caches creados
pertenecen al directorio de trabajo explícito; se conservan para inspección y
pueden descartarse después de conservar el dossier. No se limpian directorios
ajenos. El filesystem debe permanecer quiescent y se mantiene el residual
aceptado de procesos detached/reparentados.
