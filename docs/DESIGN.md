# Multi-Team SDD — Diseño v1

## Estado
- Fecha: 2026-04-19
- Estado: Draft aprobado para implementación
- Owner: rcarnicer

## Objetivo
Crear una extensión/package nueva llamada `multi-team-sdd` (separada de `pi-gentle-ai`) para orquestar trabajo multi-agente con soporte de SDD, guardrails por rol y UI visible de subagentes especializados.

---

## Decisiones cerradas

### D-001 — Package separado
`multi-team-sdd` vive como paquete/extensión independiente de `pi-gentle-ai`.

### D-002 — Orchestrator activo como extensión
El orchestrator se activa por extensión (vía inyección en system prompt + lógica runtime), no como comando manual opcional.

### D-003 — Catálogo de subagentes inicial
Subagentes a crear:
1. `explorer` (o `scout`)
2. `documentator`
3. `planner`
4. `implementer`
5. `tester-reviewer`
6. `hacker`
7. `architecture-reviewer`
8. `orchestrator` (componente de coordinación)

### D-004 — Documentator escribe specs en `./docs`
El `documentator`:
- Debe escribir en `./docs` del proyecto actual.
- Debe generar/actualizar:
  - `./docs/functional-spec.md`
  - `./docs/technical-spec.md`
- Si no tiene información suficiente, debe pedir datos explícitamente antes de inventar.

### D-005 — Implementer con TDD
`implementer` trabaja en ciclo TDD:
1. Red (tests primero)
2. Green (implementación mínima)
3. Refactor
4. Ejecuta tests y reporta evidencia

### D-006 — Tester/Reviewer solo reporta
`tester-reviewer` hace:
- análisis estático
- test E2E no programático (`curl` o `playwright`, según corresponda)
- reporte de hallazgos

No corrige código en v1; reenvía findings al `implementer`.

### D-007 — Hacker con auditoría completa
`hacker` realiza auditoría de seguridad completa (estática + dinámica), incluyendo herramientas/comandos que potencialmente pueden romper el código. Se implementa con guardrails explícitos de seguridad para evitar daño accidental.

### D-008 — UI de subagentes al iniciar
Cuando la extensión está cargada y hay UI interactiva:
- Se muestra un widget con "cajitas" de subagentes.
- Deben mostrarse en horizontal (una al lado de la otra, con wrap por ancho de terminal).
- Cada cajita muestra:
  - nombre del subagente
  - breve descripción debajo
  - color distintivo por rol

### D-009 — Architecture reviewer report-only
El `architecture-reviewer` revisa decisiones antes de implementar y conformidad
después cuando cambian límites, dependencias, contratos, persistencia o
integraciones. No modifica código ni política; reglas y excepciones materiales
requieren aprobación humana.

---

## Arquitectura propuesta

## 1) Orchestrator Runtime
Responsabilidades:
- decidir estrategia de ejecución por complejidad/riesgo/scope
- elegir entre:
  - `INLINE`
  - `SUBAGENT_SINGLE`
  - `SUBAGENT_CHAIN`
  - `SDD_INLINE`
  - `SDD_SUBAGENTS`
- registrar racional corto de decisión

Integración:
- extensión inyecta política en `before_agent_start`
- opcionalmente agrega comandos de diagnóstico (`/subagents`, `/orchestrator-status`)

## 2) Subagent Engine (`subagent` tool)
Ejecución vía subprocess de `pi`:
- `--mode json`: stream estructurado parseable
- `-p`: print mode, no TUI en subproceso
- `--no-session`: ejecución efímera sin persistir historial

Protección anti-recursión:
- variable de entorno: `PI_SUBAGENT_CHILD=1`
- si está presente, no habilitar recursión de subagentes

## 3) Agent Registry + Guardrails
- discovery de definiciones `.md` con frontmatter
- herramientas permitidas por agente (allowlist real)
- restricciones de escritura por ruta para `documentator` (`./docs/**`)
- límites de concurrencia/profundidad

---

## Roles, permisos y salidas

| Agente | Permisos | Salida esperada |
|---|---|---|
| explorer | read-only | mapa de código y contexto comprimido |
| documentator | write restringido a `./docs/**` | `functional-spec.md` + `technical-spec.md` |
| planner | read-only | plan de tareas accionables |
| architecture-reviewer | read-only | gate de diseño/conformidad arquitectónica |
| implementer | write + tests | cambios de código + evidencia TDD |
| tester-reviewer | read + ejecución de checks/tests | reporte de calidad + E2E + recomendaciones |
| hacker | análisis seguridad estático/dinámico | reporte de riesgos y PoC/checklist |
| orchestrator | coordinación | estrategia de ejecución y seguimiento |

---

## UI / UX

Widget persistente con cards horizontales de subagentes:
- Render en `session_start` y `session_tree`
- Cada card: borde, nombre, descripción corta
- Colores sugeridos:
  - orchestrator: accent
  - explorer: warning
  - documentator: mdHeading/accent
  - planner: muted
  - architecture-reviewer: accent
  - implementer: success
  - tester-reviewer: toolTitle
  - hacker: error

---

## Guardrails y seguridad operacional

- `maxParallelTasks` (ej. 8)
- `maxConcurrency` (ej. 4)
- `maxDepth` (ej. 2)
- bloqueo de recursión (`PI_SUBAGENT_CHILD=1`)
- confirmaciones explícitas para acciones peligrosas cuando haya UI
- en modo headless, políticas conservadoras por defecto

---

## Criterios de aceptación de diseño

1. Existe package `multi-team-sdd` separado.
2. Los 8 roles están definidos con contrato de entrada/salida.
3. `documentator` está obligado a producir specs en `./docs`.
4. `implementer` opera en TDD.
5. `tester-reviewer` solo reporta.
6. `hacker` cubre auditoría completa con guardrails.
7. La UI muestra cards horizontales con nombre + descripción + color.
8. El orchestrator decide estrategia de ejecución y lo justifica.
9. El architecture-reviewer es report-only y las excepciones requieren autoridad humana.
