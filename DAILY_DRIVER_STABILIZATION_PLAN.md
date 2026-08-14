Quero iniciar uma fase curta de DAILY DRIVER STABILIZATION do local-context-engine.

Leia AGENTS.md, PLAN.md, README.md e inspecione o estado atual do main e os commits recentes antes de alterar qualquer código.

OBJETIVO

Fazer o projeto ficar confiável para uso diário com Kilo/OpenAI-compatible clients + LM Studio, sem transformar o core em algo específico do LM Studio e sem implementar prematuramente outros backends.

Não iniciar v0.3.
Não adicionar MCP, retrieval, semantic compaction, SQLite, dashboard, loop guards, behavioral prompts ou novos parsers.

Não implementar Ollama/oMLX/llama.cpp/vLLM nesta fase.

A comunidade poderá implementar providers posteriormente.

==================================================
1. PRESERVAR A ARQUITETURA UNIVERSAL
==================================================

O core não deve conhecer LM Studio diretamente como política.

Manter:

TokenMeasurementProvider
        │
        ├── runtime-specific exact provider
        └── generic fallback

Runtime-specific code mede/descobre capabilities.
Budget, governor, reducer, CAS e policies permanecem runtime-agnostic.

Não espalhar:

if (lmstudio) ...

pelo core.

==================================================
2. SIMPLIFICAR O PROVIDER RESOLUTION
==================================================

Revise o commit atual que introduziu:

TokenMeasurementCapability
CapabilityTokenMeasurementProvider
LMStudioTokenProvider
OllamaTokenProvider
OmlxTokenProvider
LlamaCppTokenProvider

Atualmente Ollama/oMLX/llama.cpp são apenas stubs e capability não é usada para uma seleção real.

Não queremos suporte fictício.

Nesta fase suporte apenas:

- LMStudioTokenProvider: provider exato validado;
- Generic provider: fallback.

Outros runtimes devem permanecer extension points/documentados como roadmap, não classes vazias usadas no runtime path.

O resolver deve escolher providers com base em capability/runtime realmente detectado, e não simplesmente tentar cegamente todos os providers.

Se necessário, faça RuntimeContext/RuntimeAdapter reportar uma identificação pequena e genérica, por exemplo:

runtimeKind: "lmstudio" | "generic"

Não criar uma grande hierarquia.

==================================================
3. NÃO CRIAR O PROVIDER A CADA REQUEST
==================================================

Hoje o gateway cria o TokenMeasurementProvider dentro do handler de cada chat request.

Instancie/resolva o provider no nível adequado do gateway, preferencialmente uma vez ou lazy-once por runtime/modelo quando possível.

Não implemente cache complexo ou LRU ainda.

Apenas evite reconstrução desnecessária do LMStudioClient em toda chamada.

==================================================
4. PROMOVER MEDIÇÃO EXATA SEM ACOPLAR O REDUCER
==================================================

A validação shadow mostrou que:

LMStudioTokenProvider
→ reproduziu prompt_tokens real nos cenários testados.

CharacterTokenEstimator
→ pode superestimar E subestimar.

Portanto CharacterTokenEstimator não pode continuar sendo chamado de safety-authoritative.

Introduza uma separação clara:

A) whole-request authoritative measurement
B) local heuristic text sizing

O CharacterTokenEstimator pode continuar sendo utilizado para:

- ranking de candidatos;
- estimativa de previews;
- breakdown aproximado;
- métricas locais.

Mas decisões que significam:

- request está acima do hard budget?
- já cabe?
- reduction terminou?
- final Verify permite Forward?

devem usar a whole-request measurement authoritative quando um provider exato estiver disponível.

O reducer já é async. Prefira adaptar sua interface de forma pequena e explícita, por exemplo:

measureRequest(request): Promise<TokenMeasurement>

em vez de fazer hacks de fator de correção.

Não use:

static * 0.95
static / 1.048
ou qualquer calibration constant.

==================================================
5. TOKEN MEASUREMENT RESULT
==================================================

Considere fazer o provider retornar metadata suficiente para não perdermos semântica:

TokenMeasurement {
  tokens: number
  source: string
  confidence: "exact" | "approximate"
}

Evite fazer policy depender do nome do runtime.

Exemplo:

LM Studio SDK:
confidence = exact

Generic Character fallback:
confidence = approximate

Métricas podem registrar:

measurement_source
measurement_confidence
authoritative_input_tokens

sem conteúdo do request.

==================================================
6. MODOS SIMPLES
==================================================

Não criar dez modos.

Idealmente:

CONTEXT_TOKEN_ESTIMATOR=static
CONTEXT_TOKEN_ESTIMATOR=shadow
CONTEXT_TOKEN_ESTIMATOR=auto

static:
Character estimator é usado.

shadow:
Character continua autoridade;
runtime provider apenas mede/relata.

auto:
usa provider exato quando uma capability validada estiver disponível;
caso contrário cai para generic fallback.

Não habilite automaticamente adapters não validados.

Para esta fase, podemos usar explicitamente auto nos nossos testes antes de torná-lo default.

==================================================
7. REDUCTION + FINAL VERIFY
==================================================

A mesma estratégia authoritative precisa ser usada antes e depois da redução.

Não permitir:

antes = exact
depois = static

ou o contrário.

A regra precisa continuar:

Measure
→ Budget
→ Evict
→ Verify
→ Forward

Quando exact measurement estiver disponível:

Measure(exact)
→ Budget
→ Evict
→ Verify(exact)
→ Forward

A estimativa textual pode ajudar a escolher quanto evict, mas o critério final de fits precisa ser a medição do request completo.

Não destruir system, current user, tool schemas/descriptions, current arguments ou protocol IDs.

==================================================
8. REMOVER RAW HANDLE FALLBACK
==================================================

Remova o comportamento que pode reduzir uma mensagem para somente:

ctx://sha256/...

Já tivemos comportamento real de clients/agentes tentando interpretar isso como caminho de filesystem.

O marcador mínimo deve continuar semanticamente rotulado:

[Content archived]
Handle: ctx://sha256/...

Se nem o marcador mínimo puder satisfazer o hard budget:

fail closed.

targetTokens continua best-effort e nunca justifica emitir um raw handle.

==================================================
9. NÃO MEXER EM LIVE_EVIDENCE ALÉM DO NECESSÁRIO
==================================================

A política atual:

SAFE
→ LIVE_EVIDENCE somente sob hard overflow
→ protected permanece protected

funcionou nos testes reais.

Não adicionar novos pruning candidates.

Não implementar semantic summarization.

Só adapte a medição de fits/verify para poder utilizar a measurement authoritative.

==================================================
10. CORRIGIR DOCUMENTATION DRIFT
==================================================

Atualize AGENTS.md, PLAN.md e README.md somente depois da implementação estar validada.

Corrigir especificamente:

- README ainda chama o projeto de early v0.1 apesar do estado atual;
- PLAN possui itens do governor/classification ainda não marcados corretamente;
- AGENTS.md afirma que estimates "must be conservative", mas já demonstramos que CharacterTokenEstimator pode subestimar;
- documentação antiga cita LMStudioRuntimeEstimator, enquanto a abstração atual é TokenMeasurementProvider / LMStudioTokenProvider.

Deixe claro:

Validated runtime integration:
- LM Studio exact measurement

Generic:
- OpenAI-compatible fallback

Planned/community:
- Ollama
- oMLX
- llama.cpp
- vLLM

Não declarar esses backends como implementados antes de serem testados.

==================================================
11. NÃO FAZER AGORA
==================================================

Não:

- criar plugin system;
- criar monorepo;
- separar cinco packages;
- implementar adapters vazios;
- implementar outros backends;
- criar MCP;
- criar retrieval;
- criar banco;
- adicionar LLM calls para resumir contexto;
- alterar Kilo/OpenCode;
- criar novas heurísticas de loop;
- adicionar perfis complexos.

@lmstudio/sdk pode permanecer dependency normal por enquanto.

Opcional dependency/dynamic import pode ser avaliado antes da publicação pública, não precisa virar escopo desta fase salvo se houver motivo técnico real.

==================================================
12. TESTES OBRIGATÓRIOS
==================================================

Além da suíte atual, cubra:

1. exact provider diz que request cabe enquanto static diz que não:
   → não gerar false context_budget_exceeded.

2. exact provider diz que request NÃO cabe enquanto static diz que cabe:
   → não encaminhar oversized request.

3. exact measurement antes e depois da redução.

4. provider exato falha:
   → fallback ocorre deterministicamente e é registrado.

5. shadow continua 100% observacional.

6. generic upstream não precisa ser LM Studio para o gateway iniciar/funcionar.

7. nenhuma saída reduzida contém raw ctx:// como conteúdo isolado.

8. LIVE_EVIDENCE continua apenas em hard overflow.

9. tool call IDs/order/pairing continuam intactos.

10. nenhum request acima do authoritative safeInput alcança o mock upstream.

Execute:

npm run check
npm run build
git diff --check

==================================================
13. DAILY-DRIVER REAL TEST
==================================================

Após todos os testes automatizados passarem, prepare — mas não tente maquiar o resultado — um teste real:

Kilo
→ local-context-engine
→ LM Studio
→ Qwen 3.5 9B
→ physical context 25088
→ max_tokens 4096
→ safety reserve 2048
→ governor govern
→ token estimator auto/exact

Use tarefa real longa com tools, reads, Serena/RTK quando aplicável e múltiplos steps.

Queremos observar:

- zero upstream context overflow;
- zero false-positive context_budget_exceeded conhecido;
- measurement_source = exact;
- final authoritative_input_tokens <= safeInput;
- LIVE_EVIDENCE somente quando realmente necessário;
- nenhuma tentativa de abrir ctx:// como filesystem;
- nenhuma remoção de instructions/tool schemas;
- continuidade razoável do agente.

Não implemente nova feature se o teste falhar.
Primeiro capture métricas e determine a causa.

==================================================
14. USO DIÁRIO
==================================================

Sem criar launcher próprio ou service manager, deixe o uso simples.

Documente:

npm install
npm run check
npm run build
npm link

e um exemplo recomendado para daily use.

Preferência inicial de teste:

CONTEXT_ENGINE_UPSTREAM_URL=http://127.0.0.1:1234/v1
CONTEXT_GOVERNOR_MODE=govern
CONTEXT_TOKEN_ESTIMATOR=auto
CONTEXT_OUTPUT_RESERVE=4096
CONTEXT_SAFETY_RESERVE=2048

Não assumir CONTEXT_WINDOW_TOKENS se o LM Studio descobrir corretamente o contexto físico carregado.

O bin `local-context-engine` deve ser suficiente.

==================================================
ENTREGA
==================================================

Ao finalizar, reporte de forma objetiva:

- arquivos alterados;
- arquitetura final de measurement;
- como provider resolution funciona;
- se LM Studio exact é authoritative em auto;
- como funciona o generic fallback;
- confirmação de que outros backends NÃO foram falsamente implementados;
- confirmação de que raw ctx:// isolado não é mais emitido;
- total de testes;
- npm run check;
- npm run build;
- resultado do teste real;
- configuração que devo usar diariamente.

Não avance para outros backends ou v0.3.