// Seed state of a fresh instance: roles, tiers, the default newsletter, a sample tag, post and page,
// two themes, four integrations and the settings list. All wording here is Pressloft's own.

import { randomBytes } from 'node:crypto';
import type { Store } from './store.ts';
import { PRODUCT, newId, newUuid, nowIso } from './util.ts';

/** [key, group, default value]. Order is the order of `GET /settings/`. */
export const SETTINGS: [string, string, unknown][] = [
  ['title', 'site', PRODUCT],
  ['description', 'site', 'Notes, essays and updates from a small corner of the web.'],
  ['heading_font', 'site', ''],
  ['body_font', 'site', ''],
  ['logo', 'site', ''],
  ['cover_image', 'site', '/app/assets/cover.svg'],
  ['icon', 'site', ''],
  ['accent_color', 'site', '#2F6F5E'],
  ['locale', 'site', 'en'],
  ['timezone', 'site', 'Etc/UTC'],
  ['codeinjection_head', 'site', ''],
  ['codeinjection_foot', 'site', ''],
  ['facebook', 'site', 'pressloft'],
  ['twitter', 'site', '@pressloft'],
  ['navigation', 'site', JSON.stringify([{ label: 'Front page', url: '/' }, { label: 'Who we are', url: '/about/' }])],
  ['secondary_navigation', 'site', JSON.stringify([{ label: 'Join the list', url: '#/join/' }])],
  ['meta_title', 'site', null],
  ['meta_description', 'site', null],
  ['og_image', 'site', null],
  ['og_title', 'site', null],
  ['og_description', 'site', null],
  ['twitter_image', 'site', null],
  ['twitter_title', 'site', null],
  ['twitter_description', 'site', null],
  ['active_theme', 'theme', 'lantern'],
  ['is_private', 'private', false],
  ['password', 'private', ''],
  ['public_hash', 'private', ''],
  ['default_content_visibility', 'members', 'public'],
  ['default_content_visibility_tiers', 'members', '[]'],
  ['members_signup_access', 'members', 'all'],
  ['members_support_address', 'members', 'noreply'],
  ['stripe_secret_key', 'members', null],
  ['stripe_publishable_key', 'members', null],
  ['stripe_plans', 'members', '[]'],
  ['stripe_connect_publishable_key', 'members', null],
  ['stripe_connect_secret_key', 'members', null],
  ['stripe_connect_livemode', 'members', null],
  ['stripe_connect_display_name', 'members', null],
  ['stripe_connect_account_id', 'members', null],
  ['members_monthly_price_id', 'members', null],
  ['members_yearly_price_id', 'members', null],
  ['members_track_sources', 'members', true],
  ['blocked_email_domains', 'members', '[]'],
  ['portal_name', 'portal', true],
  ['portal_button', 'portal', false],
  ['portal_plans', 'portal', '["free"]'],
  ['portal_default_plan', 'portal', 'yearly'],
  ['portal_products', 'portal', '[]'],
  ['portal_button_style', 'portal', 'icon-and-text'],
  ['portal_button_icon', 'portal', null],
  ['portal_button_signup_text', 'portal', 'Join now'],
  ['portal_signup_terms_html', 'portal', null],
  ['portal_signup_checkbox_required', 'portal', false],
  ['mailgun_domain', 'email', null],
  ['mailgun_api_key', 'email', null],
  ['mailgun_base_url', 'email', null],
  ['email_track_opens', 'email', true],
  ['email_track_clicks', 'email', true],
  ['email_verification_required', 'email', false],
  ['amp', 'amp', false],
  ['amp_gtag_id', 'amp', null],
  ['firstpromoter', 'firstpromoter', false],
  ['firstpromoter_id', 'firstpromoter', null],
  ['labs', 'labs', ''],
  ['slack_url', 'slack', ''],
  ['slack_username', 'slack', PRODUCT],
  ['unsplash', 'unsplash', true],
  ['shared_views', 'views', '[]'],
  ['editor_default_email_recipients', 'editor', 'visibility'],
  ['editor_default_email_recipients_filter', 'editor', 'all'],
  ['announcement_content', 'announcement', null],
  ['announcement_visibility', 'announcement', '[]'],
  ['announcement_background', 'announcement', 'dark'],
  ['comments_enabled', 'comments', 'off'],
  ['outbound_link_tagging', 'analytics', true],
  ['web_analytics', 'analytics', true],
  ['pintura', 'pintura', true],
  ['pintura_js_url', 'pintura', null],
  ['pintura_css_url', 'pintura', null],
  ['donations_currency', 'donations', 'USD'],
  ['donations_suggested_amount', 'donations', '500'],
  ['recommendations_enabled', 'recommendations', false],
  ['require_email_mfa', 'security', false],
  ['social_web', 'social_web', true],
  ['explore_ping', 'explore', true],
  ['explore_ping_growth', 'explore', false],
  // Calculated settings: read-only, derived from the stored ones.
  ['members_enabled', 'members', true],
  ['members_invite_only', 'members', false],
  ['allow_self_signup', 'members', true],
  ['paid_members_enabled', 'members', false],
  ['firstpromoter_account', 'firstpromoter', null],
  ['donations_enabled', 'donations', false],
  ['default_email_address', 'email', ''],
  ['support_email_address', 'email', ''],
  ['all_blocked_email_domains', 'members', []],
  ['social_web_enabled', 'social_web', false],
  ['web_analytics_enabled', 'analytics', false],
  ['web_analytics_configured', 'analytics', false],
];

export const CALCULATED = new Set(SETTINGS.slice(SETTINGS.findIndex(([k]) => k === 'members_enabled')).map(([k]) => k));

/** Feature switches, reported in `config.labs` and the `labs` setting. */
export const LABS = { audienceFeedback: true, i18n: true, themeErrorsNotification: true, announcementBar: true, customFonts: true, contentVisibility: true, members: true };

const ROLES: [string, string][] = [
  ['Administrator', 'Runs the site: staff, settings and every post'],
  ['Editor', 'Publishes and manages everyone’s posts'],
  ['Author', 'Writes and publishes their own posts'],
  ['Contributor', 'Writes drafts for an editor to publish'],
  ['Owner', 'Created the site and holds every permission'],
  ['Admin Integration', 'Connected tools with admin access'],
  ['Directory Integration', 'Lists the site in the public directory'],
  ['Import Integration', 'Moves content in from another platform'],
  ['Backup Integration', 'Takes scheduled database backups'],
  ['Scheduler Integration', 'Publishes posts at their scheduled time'],
  ['Super Editor', 'Editor who can also manage members'],
];

function themePackage(name: string, description: string, version: string, withScreenshots: boolean, custom: Record<string, unknown>, imageSizes: Record<string, { width: number }>): Record<string, unknown> {
  return {
    name,
    description,
    demo: `https://${name}.pressloft.invalid`,
    version,
    engines: { app: '>=1.0.0' },
    license: 'MIT',
    ...(withScreenshots ? { screenshots: { desktop: 'assets/preview-wide.png', mobile: 'assets/preview-narrow.png' } } : {}),
    scripts: {
      dev: 'node build.js --watch',
      zip: 'node build.js --zip',
      test: 'node check.js',
      'test:ci': 'node check.js --strict',
      pretest: 'node build.js',
      preship: 'npm test',
      ship: 'node release.js',
      postship: 'node release.js --notes',
    },
    author: { name: 'Pressloft design team', email: 'themes@pressloft.invalid', url: 'https://pressloft.invalid/' },
    gpm: { type: 'theme', categories: ['Writing', 'Newsletter'] },
    keywords: ['pressloft', 'theme', name],
    repository: { type: 'git', url: `https://pressloft.invalid/themes/${name}.git` },
    bugs: `https://pressloft.invalid/themes/${name}/issues`,
    contributors: `https://pressloft.invalid/themes/${name}/people`,
    devDependencies: Object.fromEntries(
      ['@tryapp/release-utils', 'autoprefixer', 'beeper', 'cssnano', 'gscan', 'gulp', 'gulp-concat', 'gulp-livereload', 'gulp-postcss', 'gulp-uglify', 'gulp-zip', 'inquirer', 'postcss', ...(withScreenshots ? ['postcss-color-mod-function'] : []), 'postcss-easy-import', 'pump'].map((dep, i) => [dep, `1.${i}.0`]),
    ),
    browserslist: ['last 2 versions'],
    config: { posts_per_page: withScreenshots ? 20 : 10, image_sizes: imageSizes, card_assets: true, custom },
    renovate: { extends: ['config:base'] },
  };
}

const choice = (options: string[], extra: Record<string, unknown> = {}) => ({ type: 'select', options, default: options[0], ...extra });
const toggle = (value: boolean, extra: Record<string, unknown> = {}) => ({ type: 'boolean', default: value, ...extra });
const text = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'text', description, ...extra });

export const THEMES = [
  {
    name: 'harbor',
    active: false,
    package: themePackage(
      'harbor',
      'A roomy reading theme with large type and quiet colours',
      '2.3.0',
      true,
      {
        navigation_layout: choice(['Brand over banner', 'Brand centred', 'Brand stacked']),
        title_font: choice(['Grotesk', 'Book serif']),
        body_font: choice(['Book serif', 'Grotesk']),
        show_publication_cover: toggle(true, { group: 'homepage' }),
        header_style: choice(['Centred', 'Left', 'None'], { group: 'homepage' }),
        feed_layout: choice(['Cards', 'Tiles', 'Rows'], { group: 'homepage' }),
        color_scheme: choice(['Day', 'Night', 'Follow system']),
        post_image_style: choice(['Wide', 'Edge to edge', 'Compact', 'None'], { group: 'post' }),
        email_signup_text: { type: 'text', default: 'Get the next one by email.', group: 'post' },
        show_recent_posts_footer: toggle(true, { group: 'post' }),
      },
      { xxs: { width: 40 }, xs: { width: 120 }, s: { width: 320 }, m: { width: 640 }, l: { width: 1024 }, xl: { width: 1920 } },
    ),
  },
  {
    name: 'lantern',
    active: true,
    templates: [] as unknown[],
    package: themePackage(
      'lantern',
      'The standard Pressloft theme: tidy columns and a warm accent',
      '1.2.0',
      false,
      {
        navigation_layout: choice(['Brand centred', 'Brand left', 'Brand stacked']),
        site_background_color: { type: 'color', default: '#fbfaf7' },
        header_and_footer_color: choice(['Page colour', 'Accent colour']),
        title_font: choice(['Grotesk', 'Book serif', 'Typewriter']),
        body_font: choice(['Grotesk', 'Book serif']),
        signup_heading: text('Shown in the footer; the site title is used when empty'),
        signup_subheading: text('The site description is used when empty'),
        header_style: choice(['Welcome', 'Spotlight', 'Columns', 'Search box', 'None'], { description: 'Welcome suits most sites; Spotlight and Columns suit larger archives', group: 'homepage' }),
        header_text: text('The site description is used when empty', { group: 'homepage', visibility: 'header_style:[Welcome, Search box]' }),
        background_image: toggle(true, { description: 'Use the site cover image behind the header', group: 'homepage', visibility: 'header_style:[Welcome, Search box]' }),
        show_featured_posts: toggle(false, { group: 'homepage', visibility: 'header_style:[Spotlight, Columns]' }),
        post_feed_style: choice(['Rows', 'Tiles'], { group: 'homepage' }),
        show_images_in_feed: toggle(true, { group: 'homepage', visibility: 'post_feed_style:Rows' }),
        show_author: toggle(true, { group: 'homepage' }),
        show_publish_date: toggle(true, { group: 'homepage' }),
        show_publication_info_sidebar: toggle(false, { group: 'homepage' }),
        show_post_metadata: toggle(true, { group: 'post' }),
        enable_drop_caps_on_posts: toggle(false, { group: 'post' }),
        show_related_articles: toggle(true, { group: 'post' }),
      },
      { xs: { width: 150 }, s: { width: 300 }, m: { width: 720 }, l: { width: 1080 }, xl: { width: 1440 }, xxl: { width: 2400 } },
    ),
  },
];

const SAMPLE_MOBILEDOC = (siteTitle: string) =>
  JSON.stringify({
    version: '0.3.1',
    atoms: [],
    cards: [],
    markups: [['a', ['href', '#/join/']]],
    sections: [
      [
        1,
        'p',
        [
          [0, [], 0, `${siteTitle} has just opened its doors. The first real posts are on their way; until then, feel free to `],
          [0, [0], 1, 'join the list'],
          [0, [], 0, ' and we will write to you when something new goes up.'],
        ],
      ],
    ],
    appVersion: '1.0',
  });

/** Creates the install-time records once per database. The owner is created later, at setup. */
export function seed(store: Store): void {
  if (store.getMeta('seeded')) return;
  store.transaction(() => {
    const t = nowIso();
    for (const [name, description] of ROLES) store.put('roles', { id: newId(), name, description, created_at: t, updated_at: t });
    for (const [key, group, value] of SETTINGS) {
      let v = value;
      if (key === 'public_hash') v = randomBytes(15).toString('hex');
      if (key === 'labs') v = JSON.stringify(LABS);
      store.put('settings', { id: key, key, group, value: v });
    }
    store.put('tiers', { id: newId(), name: 'Free', slug: 'free', description: 'Every public post, free of charge.', active: true, type: 'free', welcome_page_url: null, visibility: 'public', benefits: [], currency: null, monthly_price: null, yearly_price: null, trial_days: 0, created_at: t, updated_at: t });
    store.put('tiers', { id: newId(), name: PRODUCT, slug: 'default-product', description: 'Members-only posts and the archive.', active: true, type: 'paid', welcome_page_url: null, visibility: 'public', benefits: [], currency: 'USD', monthly_price: 500, yearly_price: 5000, trial_days: 0, created_at: t, updated_at: t });
    store.put('newsletters', {
      id: newId(), uuid: newUuid(), name: PRODUCT, description: 'New posts, sent as they go up.', feedback_enabled: false, slug: 'default-newsletter', sender_name: null, sender_email: null, sender_reply_to: 'newsletter', status: 'active', visibility: 'members', subscribe_on_signup: true, sort_order: 0, header_image: null, show_header_icon: true, show_header_title: true, show_excerpt: false, title_font_category: 'sans_serif', title_alignment: 'center', show_feature_image: true, body_font_category: 'sans_serif', footer_content: null, show_badge: true, show_header_name: false, show_post_title_section: true, show_comment_cta: true, show_subscription_details: false, show_latest_posts: false, background_color: 'light', post_title_color: null, created_at: t, updated_at: t, button_corners: 'rounded', button_style: 'fill', title_font_weight: 'bold', link_style: 'underline', image_corners: 'square', header_background_color: 'transparent', section_title_color: null, divider_color: null, button_color: 'accent', link_color: 'accent',
    });
    const tagId = newId();
    store.put('tags', { id: tagId, name: 'Highlights', slug: 'highlights', description: 'Posts worth a second look.', feature_image: null, visibility: 'public', og_image: null, og_title: null, og_description: null, twitter_image: null, twitter_title: null, twitter_description: null, meta_title: null, meta_description: null, codeinjection_head: null, codeinjection_foot: null, canonical_url: null, accent_color: null, created_at: t, updated_at: t });
    store.put('posts', samplePost('post', 'Hello from Pressloft', 'hello-from-pressloft', [tagId], t));
    store.put('posts', samplePost('page', 'Who we are', 'about', [], t));
    const roles = store.all<{ id: string; name: string }>('roles');
    const roleId = (name: string) => roles.find((r) => r.name === name)?.id ?? null;
    const integrations: [string, string, string, string, string, string | null, string][] = [
      ['builtin', 'Automation hub', 'automation-hub', 'Connects your site to workflow tools', 'admin', roleId('Admin Integration'), ''],
      ['core', 'Directory listing', 'directory-listing', 'Keeps the public directory entry up to date', 'admin', roleId('Directory Integration'), ''],
      ['core', 'Content import', 'content-import', 'Brings posts over from another platform', 'admin', roleId('Import Integration'), ''],
      ['core', 'Internal reader', 'internal-reader', 'Read-only content access for the admin screens', 'content', null, ''],
    ];
    for (const [type, name, slug, description, keyType, role] of integrations) {
      const id = newId();
      store.put('integrations', {
        id, type, name, slug, icon_image: null, description, created_at: t, updated_at: t,
        api_keys: [{ id: newId(), type: keyType, secret: randomBytes(keyType === 'admin' ? 32 : 13).toString('hex'), role_id: role, integration_id: id, user_id: null, last_seen_at: null, last_seen_version: null, created_at: t, updated_at: t }],
        webhooks: [],
      });
    }
    store.setMeta('seeded', t);
  });
}

function samplePost(type: 'post' | 'page', title: string, slug: string, tagIds: string[], t: string): Record<string, unknown> & { id: string } {
  return {
    id: newId(), uuid: newUuid(), type, title, slug,
    mobiledoc: SAMPLE_MOBILEDOC(PRODUCT), lexical: null,
    feature_image: type === 'post' ? '/app/assets/cover.svg' : null,
    featured: false, status: 'published', visibility: 'public',
    created_at: t, updated_at: t, published_at: t,
    custom_excerpt: null, codeinjection_head: null, codeinjection_foot: null, custom_template: null, canonical_url: null,
    og_image: null, og_title: null, og_description: null, twitter_image: null, twitter_title: null, twitter_description: null,
    meta_title: null, meta_description: null, email_subject: null, frontmatter: null, feature_image_alt: null, feature_image_caption: null,
    email_only: false, email_segment: 'all', newsletter_id: null,
    tag_ids: tagIds, author_ids: ['1'], revisions: [],
  };
}

/** Rewrites the sample post's text once the site has a title. */
export function personalizeSample(store: Store, siteTitle: string): void {
  for (const post of store.all<{ id: string; mobiledoc?: unknown; lexical?: unknown }>('posts')) {
    if (typeof post.mobiledoc === 'string' && post.lexical === null) store.put('posts', { ...post, mobiledoc: SAMPLE_MOBILEDOC(siteTitle) });
  }
}
