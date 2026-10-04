import { useMemo } from 'react';
import './method-panel.css';
import { useConductor, useConductorLeads } from '../conductor/hooks.ts';
import { useShellState } from '../hooks.ts';
import type { GraphNode, KnowledgeGraph } from './method-model.ts';
import { buildGraph, describeGraph, methodBoxes, summarizeDraftMap, summarizeGenericMap } from './method-model.ts';

/** Where a node's text starts, in the node's own coordinates. */
const TEXT_X = 8;
const TAG_Y = 13;
const FIRST_LINE_Y = 28;
const LINE = 14;

function Node({ node }: { node: GraphNode }) {
  return (
    <g className={`mp-node mp-node--${node.kind}`} data-kind={node.kind} transform={`translate(${node.x} ${node.y})`}>
      <rect className="mp-node__box" width={node.w} height={node.h} rx="8" />
      <text className="mp-node__tag" x={TEXT_X} y={TAG_Y}>{node.tag}</text>
      <text className="mp-node__text" x={TEXT_X} y={FIRST_LINE_Y}>
        {node.lines.map((line, i) => <tspan key={i} x={TEXT_X} dy={i === 0 ? 0 : LINE}>{line}</tspan>)}
      </text>
    </g>
  );
}

function Graph({ graph }: { graph: KnowledgeGraph }) {
  return (
    <svg
      className="mp-graph__svg"
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      role="img"
      aria-label={describeGraph(graph)}
      data-testid="knowledge-graph"
      data-nodes={graph.nodes.length}
      preserveAspectRatio="xMidYMin meet"
    >
      <defs>
        <marker id="mp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className="mp-arrow" />
        </marker>
      </defs>
      {graph.edges.map((e) => <path key={e.id} className={`mp-edge mp-edge--${e.kind}`} d={e.d} markerEnd={e.kind === 'owns' ? undefined : 'url(#mp-arrow)'} />)}
      {graph.nodes.map((n) => <Node key={n.id} node={n} />)}
    </svg>
  );
}

/**
 * "How Clipa thinks": the method in five connected boxes, left to right (stacked on a phone): raw signals, events, reasoning, the
 * knowledge graph, teaching. Under each box sits the newest live item the stores have for it; without one, a short example,
 * marked as one. Below the boxes, a small graph of the current Work Map, or of the customer_07 rule while there is no map.
 */
export function MethodPanel() {
  const leads = useConductorLeads();
  const said = useConductor((s) => s.said);
  const mapSnapshot = useConductor((s) => s.map);
  const observations = useShellState((s) => s.observations);
  const events = useShellState((s) => s.events);
  const feed = useShellState((s) => s.feed);
  const checkpoint = useShellState((s) => s.teach.checkpoint);
  const draft = useShellState((s) => s.draftMap);

  const summary = useMemo(() => (leads ? summarizeGenericMap(mapSnapshot) : summarizeDraftMap(draft)), [leads, mapSnapshot, draft]);
  const boxes = methodBoxes({ observations, events, feed, said, checkpoint, summary, conductorLeads: leads });
  const graph = useMemo(() => buildGraph(summary), [summary]);

  return (
    <section className="mp" aria-labelledby="mp-title" data-testid="method-panel">
      <div className="mp__head">
        <h2 className="mp__title" id="mp-title">How Clipa thinks</h2>
        <p className="mp__lead">The screen and the mouse are raw data. Reasoning runs over them. What is learned ends up as a graph.</p>
      </div>

      <ol className="mp__flow">
        {boxes.map((box) => (
          <li key={box.id} className="mp__box" data-box={box.id} data-source={box.live === null ? 'example' : 'live'}>
            <h3 className="mp__name"><span className="mp__no" aria-hidden="true">{box.step}</span>{box.title}</h3>
            <p className="mp__what">{box.what}</p>
            <p className="mp__item" title={box.live ?? box.example}>
              {box.live === null ? (
                <><span className="mp__tag">example</span>{box.example}</>
              ) : (
                <><span className="mp__tag mp__tag--live">live</span>{box.live}{box.synthetic && <span className="mp__tag mp__tag--warn">synthetic</span>}</>
              )}
            </p>
          </li>
        ))}
      </ol>

      <figure className="mp-graph" data-source={graph.example ? 'example' : 'live'}>
        <Graph graph={graph} />
        <figcaption className="mp-graph__cap">
          {graph.example ? (
            <><span className="mp__tag">example</span>The customer_07 rule as a graph: each rule links to the expert’s words.</>
          ) : (
            <><span className="mp__tag mp__tag--live">live</span>The current Work Map as a graph: each rule links to the expert’s words.</>
          )}
        </figcaption>
      </figure>
    </section>
  );
}
