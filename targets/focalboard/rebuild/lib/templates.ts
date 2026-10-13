// The board templates a fresh instance starts with, in Tackboard's own words. Their shape (how many
// templates, and per template the card fields in order with their types and option counts) follows
// the specification; the first template also comes with a view, four cards and their content.

import { createHash, randomUUID } from 'node:crypto';
import { type Block, type Board, type CardProperty, type Store, newId } from './store.ts';

type FieldDef = [name: string, type: string, options?: string[]];

interface TemplateDef {
  title: string;
  description: string;
  icon: string;
  fields: FieldDef[];
}

const COLORS = ['propColorBlue', 'propColorGreen', 'propColorYellow', 'propColorOrange', 'propColorRed', 'propColorPurple', 'propColorPink', 'propColorBrown', 'propColorGray'];

export const TEMPLATES: TemplateDef[] = [
  {
    title: 'Team huddle',
    description: 'Collect the topics for your next team huddle, talk them through in order and keep track of what was settled.',
    icon: '🗣️',
    fields: [
      ['Status', 'select', ['To talk about', 'Parked', 'Settled']],
      ['Topic kind', 'select', ['Update', 'Decision', 'Question']],
      ['Raised by', 'createdBy'],
      ['Raised on', 'createdTime'],
    ],
  },
  {
    title: 'Hiring pipeline',
    description: 'Follow every candidate from application to offer, with interviewers, contact details and dates in one place.',
    icon: '🧑‍💼',
    fields: [
      ['Status', 'select', ['Applied', 'Screening', 'Interview', 'Take-home', 'Offer', 'Hired', 'Declined']],
      ['Interviewers', 'multiPerson'],
      ['Seniority', 'select', ['Junior', 'Mid-level', 'Senior']],
      ['Role', 'text'],
      ['Years of experience', 'number'],
      ['Team', 'select', ['Design', 'Platform', 'Mobile', 'Data', 'Security', 'Support', 'Sales', 'Marketing', 'Finance', 'Legal', 'Operations']],
      ['Email', 'email'],
      ['Phone', 'phone'],
      ['Applied on', 'date'],
      ['Interview date', 'date'],
      ['Notes', 'text'],
      ['Added', 'createdTime'],
    ],
  },
  {
    title: 'Daily checklist',
    description: 'A simple list for the day, split into morning, afternoon and evening.',
    icon: '📝',
    fields: [
      ['Part of day', 'select', ['Morning', 'Afternoon', 'Evening']],
      ['Finished', 'checkbox'],
    ],
  },
  {
    title: 'Goals and results',
    description: 'Set goals for the quarter or the year, give each an owner and a target date, and watch how they progress.',
    icon: '🏁',
    fields: [
      ['Status', 'select', ['Not started', 'On track', 'At risk', 'Behind', 'Achieved']],
      ['Horizon', 'select', ['Quarter', 'Half-year', 'Year']],
      ['Owner', 'person'],
      ['Progress (%)', 'number'],
      ['Target date', 'date'],
      ['Set by', 'createdBy'],
      ['Set on', 'createdTime'],
    ],
  },
  {
    title: 'Product roadmap',
    description: 'Plan features, fixes and chores by area, size and priority, from first idea to shipped.',
    icon: '🛣️',
    fields: [
      ['Kind', 'select', ['Feature', 'Fix', 'Chore']],
      ['Status', 'select', ['Idea', 'Planned', 'Building', 'Testing', 'Shipped']],
      ['Area', 'select', ['Web', 'iOS', 'Android', 'API', 'Billing', 'Search', 'Onboarding', 'Reports']],
      ['Size', 'select', ['Small', 'Medium', 'Large']],
      ['Priority', 'select', ['Urgent', 'High', 'Normal', 'Low']],
      ['Ship date', 'date'],
      ['Team', 'multiPerson'],
      ['Estimate (days)', 'number'],
      ['Votes', 'number'],
      ['Spec', 'text'],
      ['Notes', 'text'],
    ],
  },
  {
    title: 'Personal tasks',
    description: 'Your own to-dos, sorted by energy and context so the right task is easy to pick.',
    icon: '🧺',
    fields: [
      ['Status', 'select', ['Up next', 'Doing', 'Finished']],
      ['Energy', 'select', ['Low', 'Medium', 'High']],
      ['Context', 'select', ['Home', 'Work', 'Errands', 'Online']],
      ['Due', 'date'],
    ],
  },
  {
    title: 'Bug tracker',
    description: 'Log bugs as they are reported, rate their severity and follow them until they are fixed.',
    icon: '🐞',
    fields: [
      ['Status', 'select', ['New', 'Confirmed', 'In progress', 'In review', 'Fixed', "Won't fix", 'Duplicate']],
      ['Severity', 'select', ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial']],
      ['Platform', 'select', ['Desktop', 'Mobile', 'Server']],
      ['Reproducible', 'select', ['Always', 'Sometimes', 'Never']],
      ['Assignees', 'multiPerson'],
      ['Reported on', 'date'],
      ['Affected users', 'number'],
      ['Ticket', 'url'],
      ['Filed', 'createdTime'],
      ['Filed by', 'createdBy'],
    ],
  },
  {
    title: 'Event planning',
    description: 'Organise meetups, workshops and parties: dates, hosts, venue and the sign-up page.',
    icon: '🎪',
    fields: [
      ['Status', 'select', ['Idea', 'Booked', 'Announced', 'Running', 'Wrapped up']],
      ['Event date', 'date'],
      ['Format', 'select', ['In person', 'Online', 'Hybrid']],
      ['Contact', 'email'],
      ['Hosts', 'multiPerson'],
      ['Sign-up page', 'url'],
      ['Venue', 'text'],
    ],
  },
  {
    title: 'Reading list',
    description: 'Books and articles you want to read, are reading or have finished, with a short summary of each.',
    icon: '📚',
    fields: [
      ['Link', 'url'],
      ['Author', 'text'],
      ['Publisher', 'text'],
      ['Pages', 'number'],
      ['Summary', 'text'],
      ['Shelf', 'select', ['Want to read', 'Reading', 'Finished', 'Gave up']],
      ['Last touched', 'updatedTime'],
      ['Touched by', 'updatedBy'],
    ],
  },
  {
    title: 'Content calendar',
    description: 'Schedule posts, newsletters and videos across channels, from first draft to published.',
    icon: '📰',
    fields: [
      ['Status', 'select', ['Draft', 'Editing', 'Scheduled', 'Published', 'Archived']],
      ['Channel', 'select', ['Blog', 'Newsletter', 'Podcast', 'Video', 'Social', 'Docs', 'Press']],
      ['Topics', 'multiSelect', ['Product', 'Engineering', 'Culture', 'Customers', 'Tutorials', 'Releases', 'Events', 'Hiring']],
      ['Writer', 'person'],
      ['Draft due', 'date'],
      ['Publish date', 'date'],
      ['Draft link', 'url'],
    ],
  },
  {
    title: 'Retrospective',
    description: 'Look back on the last iteration together: what went well, what to improve, ideas and thanks.',
    icon: '🔁',
    fields: [
      ['Column', 'select', ['Went well', 'To improve', 'Ideas', 'Thanks']],
      ['Details', 'text'],
      ['Added by', 'createdBy'],
      ['Added on', 'createdTime'],
    ],
  },
  {
    title: 'Sprint board',
    description: 'Run a short sprint: size each item, rate its impact and link the change that closes it.',
    icon: '🏃',
    fields: [
      ['Status', 'select', ['Backlog', 'Active', 'Complete']],
      ['Effort', 'select', ['S', 'M', 'L']],
      ['Impact', 'select', ['Low', 'Medium', 'High']],
      ['Component', 'select', ['Frontend', 'Backend', 'Infrastructure']],
      ['Owner', 'person'],
      ['Due date', 'date'],
      ['Created', 'createdTime'],
      ['Change link', 'url'],
    ],
  },
  {
    title: 'Onboarding plan',
    description: 'Help a new teammate settle in week by week, with a buddy, deadlines and links to the guides.',
    icon: '🌱',
    fields: [
      ['Status', 'select', ['To do', 'In progress', 'Waiting', 'Complete']],
      ['Week', 'select', ['Week one', 'Week two', 'Week three']],
      ['Buddy', 'person'],
      ['Deadline', 'date'],
      ['Required', 'checkbox'],
      ['Updated', 'updatedTime'],
      ['Guide', 'url'],
      ['Added by', 'createdBy'],
    ],
  },
];

// The first template's sample cards: [title, icon, status option, kind option, sections].
// Each section is a heading, a note, a divider and three to-dos.
interface Section {
  heading: string;
  note: string;
  todos: [string, string, string];
}
const HUDDLE_CARDS: [string, string, number, number, Section[]][] = [
  ['Release checklist review', '🛠️', 0, 1, [{ heading: '### Background', note: 'The release steps have grown over time; agree which ones still matter.', todos: ['List the current steps', 'Mark the ones nobody runs', 'Pick an owner for the list'] }]],
  ['New colour palette', '🎨', 0, 0, [{ heading: '### Background', note: 'Design shared two palettes for the app; collect first reactions.', todos: ['Share both palettes', 'Check contrast in dark mode', 'Gather feedback by Thursday'] }]],
  ['Flaky test cleanup', '🧪', 2, 2, [{ heading: '### Background', note: 'A handful of tests fail now and then and slow everybody down.', todos: ['Collect the failing tests', 'Quarantine the worst ones', 'Book a fix-it afternoon'] }]],
  [
    'Team lunch on Friday',
    '🍕',
    1,
    0,
    [
      { heading: '### Background', note: 'Celebrate the end of the quarter together.', todos: ['Find a date that suits everyone', 'Ask about dietary needs', 'Reserve a table'] },
      { heading: '### Follow-up', note: 'Keep the receipts for the team budget.', todos: ['Collect receipts', 'Send the total to finance', 'Post photos in the channel'] },
    ],
  ],
];

function propertiesFor(def: TemplateDef): CardProperty[] {
  return def.fields.map(([name, type, options = []]) => ({
    id: randomUUID(),
    name,
    type,
    options: options.map((value, i) => ({ id: randomUUID(), value, color: COLORS[i % COLORS.length]! })),
  }));
}

function emptyViewFields(): Record<string, unknown> {
  return {
    viewType: 'board',
    cardOrder: [],
    sortOptions: [],
    visiblePropertyIds: [],
    visibleOptionIds: [],
    hiddenOptionIds: [],
    collapsedOptionIds: [],
    filter: { operation: 'and', filters: [] },
    columnWidths: {},
    columnCalculations: {},
    kanbanCalculations: {},
    defaultTemplateId: '',
  };
}

/** Creates the templates on a fresh database (once per database). */
export function seedTemplates(store: Store): void {
  if (store.getMeta('templatesSeeded')) return;
  const start = Date.now();
  store.transaction(() => {
    TEMPLATES.forEach((def, index) => {
      const at = start + index;
      const board: Board = {
        id: newId('b'),
        teamId: '0',
        channelId: '',
        createdBy: 'system',
        modifiedBy: 'system',
        type: 'O',
        minimumRole: '',
        title: def.title,
        description: def.description,
        icon: def.icon,
        showDescription: true,
        isTemplate: true,
        templateVersion: 1,
        properties: { trackingTemplateId: createHash('md5').update(`tackboard-template:${def.title}`).digest('hex') },
        cardProperties: propertiesFor(def),
        createAt: at,
        updateAt: at,
        deleteAt: 0,
      };
      store.putBoard(board);
      const block = (type: string, parentId: string, title: string, fields: Record<string, unknown>, kind = 'a'): Block => ({
        id: newId(kind),
        parentId,
        createdBy: 'system',
        modifiedBy: 'system',
        schema: 1,
        type,
        title,
        fields,
        createAt: at,
        updateAt: at,
        deleteAt: 0,
        boardId: board.id,
      });
      if (index !== 0) {
        const group = board.cardProperties.find((p) => p.type === 'select');
        store.putBlock(block('view', board.id, 'Board', { ...emptyViewFields(), ...(group ? { groupById: group.id } : {}) }, 'v'));
        return;
      }
      const [status, kind] = board.cardProperties as [CardProperty, CardProperty];
      const cards: Block[] = [];
      const content: Block[] = [];
      for (const [title, icon, s, k, sections] of HUDDLE_CARDS) {
        const card = block('card', board.id, title, { icon, properties: { [status.id]: status.options[s]!.id, [kind.id]: kind.options[k]!.id }, contentOrder: [], isTemplate: false }, 'c');
        const own: Block[] = [];
        for (const section of sections) {
          own.push(block('text', card.id, section.heading, {}), block('text', card.id, section.note, {}), block('divider', card.id, '', {}));
          for (const todo of section.todos) own.push(block('checkbox', card.id, todo, { value: false }));
        }
        card.fields = { ...card.fields, contentOrder: own.map((b) => b.id) };
        cards.push(card);
        content.push(...own);
      }
      const view = block(
        'view',
        board.id,
        'Huddle topics',
        {
          ...emptyViewFields(),
          cardOrder: cards.map((c) => c.id),
          groupById: status.id,
          hiddenOptionIds: [''],
          sortOptions: [{ propertyId: kind.id, reversed: false }],
          visiblePropertyIds: [kind.id],
        },
        'v',
      );
      // Stored cards first, then the view, then content grouped by type.
      const rank = (b: Block) => ['text', 'divider', 'checkbox'].indexOf(b.type);
      for (const b of [...cards, view, ...content.sort((x, y) => rank(x) - rank(y))]) store.putBlock(b);
    });
    store.setMeta('templatesSeeded', String(start));
  });
}
