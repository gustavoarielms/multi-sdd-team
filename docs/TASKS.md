# Multi-Team SDD — Plan de tareas (v1)

## Estado
- Fecha: 2026-04-19
- Basado en: `docs/DESIGN.md`
- Estado actual: implementación inicial completada, faltan validaciones E2E finales

---

## Fase 0 — Scaffold del package
- [x] Crear estructura base del package `multi-team-sdd`
- [x] Definir `package.json` con recurso de extensiones/prompts/agents
- [x] Agregar README inicial con instalación local

**Verificación**
- [ ] `pi -e /abs/path/multi-team-sdd` carga sin errores de módulo.

---

## Fase 1 — Engine de subagentes
- [x] Portar/crear tool `subagent` con modos `single`, `chain`, `parallel`
- [x] Ejecutar subprocesos con `pi --mode json -p --no-session`
- [x] Parsear stream JSON y consolidar output final
- [x] Implementar `PI_SUBAGENT_CHILD=1` para evitar recursión
- [x] Agregar límites: `maxParallelTasks`, `maxConcurrency`, `maxDepth` (depth guard preparado por env + política)

**Verificación**
- [ ] Single funciona
- [ ] Chain pasa contexto `{previous}`
- [ ] Parallel respeta límites
- [ ] Recursión queda bloqueada

---

## Fase 2 — Registry y definición de agentes
- [x] Implementar `agent-registry` (discovery + frontmatter)
- [x] Crear agentes:
  - [x] explorer
  - [x] documentator
  - [x] planner
  - [x] implementer
  - [x] tester-reviewer
  - [x] hacker
  - [x] architecture-reviewer
  - [x] orchestrator
- [x] Definir allowlist de tools por agente
- [x] Restringir `documentator` a escritura en `./docs/**` (child guardrails)

**Verificación**
- [ ] `/subagents` lista roles y capacidades
- [ ] Documentator no puede escribir fuera de `./docs`
- [ ] Planner/explorer no pueden mutar archivos

---

## Fase 3 — Orchestrator activo
- [x] Inyectar política de orquestación en `before_agent_start`
- [x] Definir heurística de routing:
  - [x] INLINE
  - [x] SUBAGENT_SINGLE
  - [x] SUBAGENT_CHAIN
  - [x] SDD_INLINE
  - [x] SDD_SUBAGENTS
- [x] Registrar rationale corto de decisión (mandato en prompt del orchestrator)

**Verificación**
- [ ] prompts simples van inline
- [ ] tareas complejas disparan chain
- [ ] solicitudes SDD pueden ir por ruta subagentes

---

## Fase 4 — UI de cards de subagentes
- [x] Implementar widget persistente con cards horizontales
- [x] Mostrar nombre + descripción por agente
- [x] Aplicar color por rol
- [x] Soportar wrap por ancho de terminal
- [x] Renderizar en `session_start` y `session_tree`

**Verificación**
- [ ] Al iniciar pi con extensión se ven las cards
- [ ] En terminal angosta hace wrap sin romper layout
- [ ] Cada agente mantiene color y descripción

---

## Fase 5 — Flujos específicos por rol
### 5.1 Documentator
- [x] Forzar generación de:
  - [x] `./docs/functional-spec.md`
  - [x] `./docs/technical-spec.md`
- [x] Si falta contexto, pedir datos explícitos y no inventar

### 5.2 Implementer (TDD)
- [x] Plantilla de ejecución Red/Green/Refactor
- [x] Evidencia de tests ejecutados en salida

### 5.3 Tester/Reviewer
- [x] Checklist estático
- [x] Ejecutar E2E no programático (`curl`/`playwright`) en contrato de agente
- [x] Reportar y reenviar a implementer (sin fix en v1)

### 5.4 Hacker
- [x] Checklist de seguridad estática
- [x] Modo de auditoría dinámica con guardrails (`security-mode`)
- [x] Reporte final de vulnerabilidades y severidad

### 5.5 Architecture Reviewer
- [x] Revisión report-only de diseño y conformidad
- [x] Activación por cambios arquitectónicamente sensibles
- [x] Excepciones reservadas a autoridad humana

**Verificación**
- [ ] Cada rol produce salida según contrato

---

## Fase 6 — Hardening y validación e2e
- [x] Casos de error (agente inexistente, abort, errores de subprocess) manejados
- [x] Fallbacks headless/UI en comandos y widget
- [ ] Pruebas con proyecto real (workflow completo)
- [x] Documentación operativa en README

**Verificación**
- [ ] Demo end-to-end: explorer → planner → implementer → tester-reviewer → hacker
- [ ] Logs y reportes legibles

---

## Definition of Done (v1)
- [ ] Package separado instalable con `pi -e`.
- [x] Subagent tool estable con 3 modos.
- [x] 7 subagentes especializados + orchestrator operativo.
- [x] UI de cards horizontal con descripción.
- [x] Documentator escribe specs en `./docs`.
- [x] Implementer TDD + Tester/Reviewer report-only.
- [x] Hacker con auditoría completa y guardrails.
- [x] README con setup y límites conocidos.

---

## Fase 7 — Governance contract v1
- [x] Definir schemas modulares para resultados, findings, evidencia, gates, reglas y excepciones
- [x] Separar severidad, recomendación del agente y efecto efectivo del gate
- [x] Exigir autoridad humana para reglas aprobadas y excepciones
- [x] Rechazar evidencia cruda no declarada y exigir metadata de redacción
- [x] Agregar ejemplos y validación estricta Draft 2020-12
- [x] Validar integridad de referencias dentro del resultado de agente

**Verificación**
- [x] `npm run check:governance`
- [ ] Los agentes Pi y Codex emiten el contrato v1
- [ ] El orchestrator rechaza handoffs estructurados inválidos
