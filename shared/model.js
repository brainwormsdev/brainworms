// The model, as registered. Model v2 was written down here, fingerprinted and timestamped before any
// simulation of it was run; its code has to do exactly this. Like a lab protocol, it is never edited
// after its results are known: a change is a new version, and every version's results stay published.
// test/model.test.js pins its SHA-256.

const deepFreeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deepFreeze(x[k]); } return x; };

export const MODEL_V2 = deepFreeze({
  id: 'model-v2',
  version: 2,
  registered: '2026-09-26',
  registeredBefore: 'any simulation of model v2 was run',
  replaces: 'model v1: each cell\'s input divided by its total synapse count, times one gain (2.2); every synapse excitatory; any input to a ciliated cell stops it beating',
  why: 'Under model v1 one poke lit up 93% of the body, and every pass/fail test in the lab failed: when everything lights up, nothing can be specific. Model v1\'s results stay published.',
  rules: [
    {
      id: 'strength',
      rule: 'A connection\'s strength is its synapse count times one number, c, the same for every synapse. Nothing is divided by the receiving cell\'s total input.',
      why: 'Real synaptic input grows with the number of synapses, and the fly model (Shiu et al. 2024) also uses synapse counts. Model v1 divided each cell\'s input by its total, so a cell with one input synapse was as easy to drive as one with a hundred.',
    },
    {
      id: 'no-amplification',
      rule: 'c = 1 / (the largest eigenvalue magnitude of the synapse-count matrix) = 1 / 30.998 = 0.03226. It is computed from the wiring, not chosen.',
      why: 'At this strength no loop in the wiring can grow on its own: activity spreads along strong connections and fades along weak ones, and only a stimulus keeps it going. Model v1\'s gain of 2.2 let every loop amplify itself.',
    },
    {
      id: 'cilia',
      rule: 'A ciliated cell stops beating in proportion to the activity of its cholinergic inputs, and serotonergic input keeps it beating: arrest = A × (1 − S), where A and S are the synapse-weighted mean activities of the cell\'s cholinergic and serotonergic inputs (0 if it has none). A side of the body beats at 1 − the mean arrest of that side\'s ciliated cells. Any other input no longer stops the cilia.',
      why: 'The lab found that cholinergic cells drive the coordinated arrests of all cilia and that serotonin inhibits that rhythm (Verasztó et al. 2017), and that the eyespot changes the beating of the cilia next to it through cholinergic synapses (Jékely et al. 2008). Transmitters come from the lab\'s cell-type table (data/transmitters.json).',
    },
    {
      id: 'serotonin-inhibits',
      rule: 'Synapses from serotonergic cells onto the cholinergic cells that synapse on ciliated cells are inhibitory (negative strength). Every other synapse stays excitatory.',
      why: 'The same study: serotonin inhibits the cholinergic rhythm; these synapses are its route in the wiring (Ser-h1 onto MC, Ser-tr1 onto Loop and others). For 97% of neurons the transmitter is unknown, so no other sign can be read from the data.',
    },
    {
      id: 'rhythm',
      rule: 'Stop-and-go: the MC cell gets a drive of 1.0 for 60 steps (2 s) every 2,130 steps (71 s), from step 2,130 on.',
      why: 'The lab recorded MC activating periodically with a median cycle of 71 s (Verasztó et al. 2017). How long each burst lasts is not reported: the 2 s is ours. How long the cilia stay stopped is up to the wiring.',
    },
    {
      id: 'unchanged',
      rule: 'Unchanged from model v1: tanh firing-rate cells with threshold 0.05, rate time constant 3 steps, fatigue (time constant 40 steps, strength 1.5), 30 steps per second, the eye mapping, pokes, the lamp, and the body\'s physics apart from the cilia rule.',
      why: 'One change at a time where possible; these were never what the tests measured.',
    },
  ],
  notDone: [
    { what: 'spiking neurons', why: 'With the fly model\'s published spiking parameters, a cell needs about two dozen input synapses firing at typical rates to reach threshold; 92% of this worm\'s cells have fewer, so borrowing them would silence it, and there are no worm-specific parameters to use instead.' },
    { what: 'inhibition elsewhere', why: 'The transmitter is known for 79 of 2,675 cells; guessing the rest would be inventing.' },
    { what: 'faster beating from serotonin', why: 'The lab reports that serotonin increases beat frequency but not by how much.' },
  ],
  params: { strength: 0.03226, theta: 0.05, tau: 3, tauA: 40, adapt: 1.5, rhythm: { cell: 'MC', drive: 1, onSteps: 60, periodSteps: 2130 } },
  references: [
    'Verasztó C, et al. Ciliomotor circuitry underlying whole-body coordination of ciliary activity in the Platynereis larva. eLife 6:e26000 (2017)',
    'Jékely G, et al. Mechanism of phototaxis in marine zooplankton. Nature 456:395-399 (2008)',
    'Bezares-Calderón LA, et al. Neural circuitry of a polycystin-mediated hydrodynamic startle response for predator avoidance. eLife 7:e36262 (2018)',
    'Shiu PK, et al. A Drosophila computational brain model reveals sensorimotor processing. Nature (2024)',
  ],
});
