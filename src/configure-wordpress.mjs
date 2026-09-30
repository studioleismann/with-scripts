import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { isCancel, log, multiselect, note, outro, select } from '@clack/prompts';
import {
  ask,
  askRequired,
  askYesNo,
  createPrompts,
  interactive,
  run,
  runCapture,
} from './cli.mjs';

const profiles = {
  standard: {
    language: 'de_DE',
    pages: {
      home: { title: 'Startseite', status: 'publish' },
      blog: { title: 'Blog', status: 'publish' },
      legal: { title: 'Rechtliches', status: 'draft' },
      privacy: { title: 'Datenschutzerklärung', status: 'draft', parent: 'legal' },
      imprint: { title: 'Impressum', status: 'draft', parent: 'legal' },
    },
    plugins: [
      { slug: 'query-monitor', label: 'Query Monitor' },
      { slug: 'wpvivid-backuprestore', label: 'WPvivid Backup' },
      { slug: 'aryo-activity-log', label: 'Activity Log' },
    ],
    activityLogDays: 128,
    media: {
      mediumFallback: 640,
      largeFallback: 1280,
      thumbnail: 160,
      cropThumbnail: true,
    },
    theme: null,
  },
};

const inspectPhp = String.raw`
$pages = get_posts(array(
    'post_type' => 'page',
    'post_status' => array('publish', 'draft', 'private', 'pending'),
    'numberposts' => -1,
    'orderby' => 'ID',
    'order' => 'ASC',
));
$page_rows = array();
foreach ($pages as $page) {
    $page_rows[] = array(
        'id' => (int) $page->ID,
        'title' => $page->post_title,
        'status' => $page->post_status,
        'parent' => (int) $page->post_parent,
        'marker' => (string) get_post_meta($page->ID, '_with_scripts_setup_key', true),
    );
}
$plugins = array();
if (!function_exists('get_plugins')) {
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
}
foreach (get_plugins() as $file => $data) {
    $slug = dirname($file);
    if ('.' === $slug) {
        $slug = basename($file, '.php');
    }
    $plugins[$slug] = is_plugin_active($file) ? 'active' : 'inactive';
}
$themes = array();
foreach (wp_get_themes() as $slug => $theme) {
    $themes[] = array(
        'slug' => $slug,
        'name' => $theme->get('Name'),
        'active' => get_stylesheet() === $slug,
    );
}
$categories = array();
foreach (get_categories(array('hide_empty' => false)) as $category) {
    $categories[] = array('id' => (int) $category->term_id, 'name' => $category->name);
}
$post_one = get_post(1);
$page_two = get_post(2);
$comment_one = get_comment(1);
$payload = array(
    'multisite' => is_multisite(),
    'environmentType' => wp_get_environment_type(),
    'locale' => get_locale(),
    'homeUrl' => home_url('/'),
    'siteTitle' => (string) get_option('blogname'),
    'tagline' => (string) get_option('blogdescription'),
    'adminEmail' => (string) get_option('admin_email'),
    'blogPublic' => (int) get_option('blog_public'),
    'showAvatars' => (int) get_option('show_avatars'),
    'yearMonthUploads' => (int) get_option('uploads_use_yearmonth_folders'),
    'defaultCategory' => (int) get_option('default_category'),
    'mediumSize' => (int) get_option('medium_size_w'),
    'largeSize' => (int) get_option('large_size_w'),
    'thumbnailSize' => (int) get_option('thumbnail_size_w'),
    'thumbnailCrop' => (int) get_option('thumbnail_crop'),
    'timezone' => (string) get_option('timezone_string'),
    'dateFormat' => (string) get_option('date_format'),
    'timeFormat' => (string) get_option('time_format'),
    'permalinkStructure' => (string) get_option('permalink_structure'),
    'defaultCommentStatus' => (string) get_option('default_comment_status'),
    'defaultPingStatus' => (string) get_option('default_ping_status'),
    'activityLogDays' => (string) (get_option('activity-log-settings', array())['logs_lifespan'] ?? ''),
    'coreAutoUpdates' => defined('WP_AUTO_UPDATE_CORE') ? WP_AUTO_UPDATE_CORE : null,
    'pluginAutoUpdates' => array_values((array) get_site_option('auto_update_plugins', array())),
    'showOnFront' => (string) get_option('show_on_front'),
    'pageOnFront' => (int) get_option('page_on_front'),
    'pageForPosts' => (int) get_option('page_for_posts'),
    'privacyPage' => (int) get_option('wp_page_for_privacy_policy'),
    'configuredOptions' => array(
        'blogname' => get_option('blogname'),
        'blogdescription' => get_option('blogdescription'),
        'admin_email' => get_option('admin_email'),
        'timezone_string' => get_option('timezone_string'),
        'date_format' => get_option('date_format'),
        'time_format' => get_option('time_format'),
        'permalink_structure' => get_option('permalink_structure'),
        'default_comment_status' => get_option('default_comment_status'),
        'default_ping_status' => get_option('default_ping_status'),
        'blog_public' => (int) get_option('blog_public'),
        'show_avatars' => (int) get_option('show_avatars'),
        'uploads_use_yearmonth_folders' => (int) get_option('uploads_use_yearmonth_folders'),
    ),
    'contentSize' => function_exists('wp_get_global_settings') ? wp_get_global_settings(array('layout', 'contentSize'), array('origin' => 'base')) : null,
    'wideSize' => function_exists('wp_get_global_settings') ? wp_get_global_settings(array('layout', 'wideSize'), array('origin' => 'base')) : null,
    'pages' => $page_rows,
    'postCount' => (int) wp_count_posts('post')->publish + (int) wp_count_posts('post')->draft,
    'commentCount' => (int) wp_count_comments()->total_comments,
    'plugins' => $plugins,
    'themes' => $themes,
    'categories' => $categories,
    'samplePost' => $post_one && 'post' === $post_one->post_type ? array(
        'id' => 1,
        'title' => $post_one->post_title,
        'name' => $post_one->post_name,
        'type' => $post_one->post_type,
    ) : null,
    'samplePage' => $page_two && 'page' === $page_two->post_type ? array(
        'id' => 2,
        'title' => $page_two->post_title,
        'name' => $page_two->post_name,
        'type' => $page_two->post_type,
    ) : null,
    'sampleComment' => $comment_one ? array(
        'id' => 1,
        'author' => $comment_one->comment_author,
        'postId' => (int) $comment_one->comment_post_ID,
    ) : null,
);
echo 'WITH_SCRIPTS_JSON:' . wp_json_encode($payload);
`;

export function parseConfigureWordPressArgs(args) {
  let profileName = 'standard';
  let dryRun = false;
  let check = false;
  for (const argument of args) {
    if (argument.startsWith('--profile=')) {
      profileName = argument.slice('--profile='.length).trim();
      continue;
    }
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (!profiles[profileName]) {
    throw new Error(`Unknown WordPress profile: ${profileName}`);
  }
  if (dryRun && check) {
    throw new Error('Use either --dry-run or --check, not both.');
  }
  return { profileName, dryRun, check };
}

export function pixelsFromLayout(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  const match = typeof value === 'string' ? value.trim().match(/^(\d+(?:\.\d+)?)px$/i) : null;
  return match ? Math.round(Number(match[1])) : fallback;
}

export function buildConfigurePhp(configuration) {
  const encoded = Buffer.from(JSON.stringify(configuration)).toString('base64');
  return String.raw`
$config = json_decode(base64_decode('${encoded}'), true);
if (!is_array($config)) {
    throw new RuntimeException('Invalid with-scripts configuration.');
}
if (is_multisite()) {
    throw new RuntimeException('Multisite is not supported by configure-wordpress.');
}
$results = array();
foreach ($config['samples'] as $sample) {
    if ('comment' === $sample['kind']) {
        $current = get_comment($sample['id']);
        if ($current && $current->comment_author === $sample['author'] && (int) $current->comment_post_ID === (int) $sample['postId']) {
            wp_delete_comment($sample['id'], true);
            $results[] = 'Deleted sample comment #' . $sample['id'];
        }
        continue;
    }
    $current = get_post($sample['id']);
    if ($current && $current->post_type === $sample['type'] && $current->post_title === $sample['title'] && $current->post_name === $sample['name']) {
        wp_delete_post($sample['id'], true);
        $results[] = 'Deleted sample content #' . $sample['id'];
    }
}
$page_ids = array();
foreach ($config['pages'] as $key => $page) {
    $selection = trim((string) $page['selection']);
    $selected_existing = ctype_digit($selection);
    $marked = get_posts(array(
        'post_type' => 'page',
        'post_status' => 'any',
        'numberposts' => -1,
        'meta_key' => '_with_scripts_setup_key',
        'meta_value' => $key,
    ));
    $post = null;
    if ($selected_existing) {
        $post = get_post((int) $selection);
        if (!$post || 'page' !== $post->post_type) {
            throw new RuntimeException('Selected page #' . $selection . ' does not exist.');
        }
    } elseif (!empty($marked)) {
        $post = reset($marked);
    }
    $parent_id = !empty($page['parent']) ? ($page_ids[$page['parent']] ?? 0) : 0;
    if (!$post) {
        $post_id = wp_insert_post(array(
            'post_type' => 'page',
            'post_title' => $selection,
            'post_name' => sanitize_title($selection),
            'post_status' => $page['status'],
            'post_parent' => $parent_id,
            'comment_status' => 'closed',
            'ping_status' => 'closed',
        ), true);
        if (is_wp_error($post_id)) {
            throw new RuntimeException($post_id->get_error_message());
        }
        $post = get_post($post_id);
        $results[] = 'Created page: ' . $post->post_title;
    } elseif (!$selected_existing) {
        $updated = wp_update_post(array(
            'ID' => $post->ID,
            'post_title' => $selection,
            'post_name' => sanitize_title($selection),
            'post_status' => $page['status'],
            'post_parent' => $parent_id,
            'comment_status' => 'closed',
            'ping_status' => 'closed',
        ), true);
        if (is_wp_error($updated)) {
            throw new RuntimeException($updated->get_error_message());
        }
        $post = get_post($updated);
    } elseif ((int) $post->post_parent !== $parent_id && !empty($page['parent'])) {
        wp_update_post(array('ID' => $post->ID, 'post_parent' => $parent_id));
    }
    foreach ($marked as $old_marked) {
        if ((int) $old_marked->ID !== (int) $post->ID) {
            delete_post_meta($old_marked->ID, '_with_scripts_setup_key');
        }
    }
    update_post_meta($post->ID, '_with_scripts_setup_key', $key);
    $page_ids[$key] = (int) $post->ID;
}
$options = $config['options'];
$options['show_on_front'] = 'page';
$options['page_on_front'] = $page_ids['home'];
$options['page_for_posts'] = $page_ids['blog'];
$options['wp_page_for_privacy_policy'] = $page_ids['privacy'];
foreach ($options as $name => $value) {
    if (get_option($name) != $value) {
        update_option($name, $value);
        $results[] = 'Updated option: ' . $name;
    }
}
if (!empty($config['closeExistingComments'])) {
    $content = get_posts(array(
        'post_type' => array('post', 'page'),
        'post_status' => 'any',
        'numberposts' => -1,
    ));
    foreach ($content as $item) {
        if ('closed' !== $item->comment_status || 'closed' !== $item->ping_status) {
            wp_update_post(array('ID' => $item->ID, 'comment_status' => 'closed', 'ping_status' => 'closed'));
        }
    }
}
if (!empty($config['media'])) {
    foreach ($config['media'] as $name => $value) {
        update_option($name, $value);
    }
}
if (!empty($config['defaultCategory'])) {
    $category = get_term((int) $config['defaultCategory'], 'category');
    if (!$category || is_wp_error($category)) {
        throw new RuntimeException('The selected default category does not exist.');
    }
    update_option('default_category', (int) $config['defaultCategory']);
}
$activity_settings = get_option('activity-log-settings', array());
if (!empty($config['configureActivityLog'])) {
    if (!is_array($activity_settings)) {
        $activity_settings = array();
    }
    $activity_settings['logs_lifespan'] = (string) $config['activityLogDays'];
    if (!isset($activity_settings['logs_failed_login'])) {
        $activity_settings['logs_failed_login'] = 'yes';
    }
    if (!isset($activity_settings['logs_email'])) {
        $activity_settings['logs_email'] = 'yes';
    }
    update_option('activity-log-settings', $activity_settings);
}
flush_rewrite_rules();
echo 'WITH_SCRIPTS_JSON:' . wp_json_encode(array('pages' => $page_ids, 'results' => $results));
`;
}

export async function configureWordPress(args = []) {
  const { profileName, dryRun, check } = parseConfigureWordPressArgs(args);
  const profile = profiles[profileName];
  const projectRoot = process.cwd();

  if (!existsSync(path.join(projectRoot, '.ddev', 'config.yaml'))) {
    throw new Error('No local DDEV project found. Run this command from a project with .ddev/config.yaml.');
  }

  note(`Profile: ${profileName}\nProject: ${projectRoot}\nTarget: current local DDEV WordPress installation`, 'Configure WordPress');

  run('Starting local DDEV project', 'ddev', ['start']);
  run('Checking local WordPress installation', 'ddev', ['wp', 'core', 'is-installed', '--quiet']);
  const inspection = parseJsonOutput(runCapture(
    'Inspecting local WordPress',
    'ddev',
    ['wp', 'eval', inspectPhp],
  ));
  if (inspection.multisite) {
    throw new Error('WordPress Multisite is not supported by configure-wordpress.');
  }

  if (check) {
    const expectedMedium = pixelsFromLayout(inspection.contentSize, profile.media.mediumFallback);
    const expectedLarge = pixelsFromLayout(inspection.wideSize, profile.media.largeFallback);
    const markedPages = Object.fromEntries(
      inspection.pages.filter((page) => page.marker).map((page) => [page.marker, page.id]),
    );
    const checks = [
      [`WordPress language is ${profile.language}`, inspection.locale === profile.language],
      ['Timezone is Europe/Berlin', inspection.timezone === 'Europe/Berlin'],
      ['Date format is d.m.Y', inspection.dateFormat === 'd.m.Y'],
      ['Time format is H:i', inspection.timeFormat === 'H:i'],
      ['Permalinks use post names', inspection.permalinkStructure === '/%postname%/'],
      ['New comments are closed', inspection.defaultCommentStatus === 'closed'],
      ['New pingbacks are closed', inspection.defaultPingStatus === 'closed'],
      ['Core auto-updates are minor releases', inspection.coreAutoUpdates === 'minor'],
      ['Plugin auto-updates are disabled', inspection.pluginAutoUpdates.length === 0],
      [`Activity Log keeps ${profile.activityLogDays} days`, inspection.activityLogDays === String(profile.activityLogDays)],
      [`Medium media size is ${expectedMedium}px`, Number(inspection.mediumSize) === expectedMedium],
      [`Large media size is ${expectedLarge}px`, Number(inspection.largeSize) === expectedLarge],
      [`Thumbnail media size is ${profile.media.thumbnail}px`, Number(inspection.thumbnailSize) === profile.media.thumbnail],
      ['Thumbnail cropping is enabled', inspection.thumbnailCrop === 1],
      ['Static front-page mode is enabled', inspection.showOnFront === 'page'],
      ['Homepage assignment matches the profile page', inspection.pageOnFront === markedPages.home],
      ['Posts-page assignment matches the profile page', inspection.pageForPosts === markedPages.blog],
      ['Privacy-page assignment matches the profile page', inspection.privacyPage === markedPages.privacy],
      ...Object.keys(profile.pages).map((key) => [
        `Page assignment ${key} exists`,
        inspection.pages.some((page) => page.marker === key),
      ]),
      ...profile.plugins.map((plugin) => [
        `${plugin.label} is active`,
        inspection.plugins[plugin.slug] === 'active',
      ]),
    ];
    console.log('\nProfile check:');
    for (const [label, passed] of checks) {
      console.log(`  ${passed ? 'OK' : 'MISSING'}  ${label}`);
    }
    if (checks.some(([, passed]) => !passed)) {
      process.exitCode = 1;
    }
    return;
  }

  note(`Environment: ${inspection.environmentType}\nPages: ${inspection.pages.length}\nPosts: ${inspection.postCount}\nComments: ${inspection.commentCount}\nURL: ${inspection.homeUrl}`, 'Current local site');
  if (!inspection.homeUrl.startsWith('https://')) {
    log.warn('The local WordPress home URL does not use HTTPS.');
  }
  if (inspection.pages.length) {
    note(inspection.pages.map((page) => `${page.id}  [${page.status}] ${page.title || '(untitled)'}`).join('\n'), 'Existing pages');
  }
  if (!interactive && inspection.categories.length) {
    console.log('\nAvailable post categories:');
    for (const category of inspection.categories) {
      console.log(`  ${String(category.id).padStart(4)}  ${category.name}`);
    }
  }

  const rl = createPrompts();
  try {
    const inferredFresh = inspection.pages.length <= 2 && inspection.postCount <= 1;
    const fresh = await askYesNo(rl, 'Is this a fresh WordPress installation?', inferredFresh);
    const selections = {};
    for (const [key, page] of Object.entries(profile.pages)) {
      const marked = inspection.pages.find((candidate) => candidate.marker === key);
      const label = `${page.title}: enter an existing page ID or a title for a new page`;
      selections[key] = await askRequired(rl, label, marked ? String(marked.id) : page.title);
    }

    const language = await askRequired(rl, 'WordPress language', profile.language);
    const siteTitle = await askRequired(rl, 'Site title', inspection.siteTitle);
    const taglineInput = await ask(rl, 'Tagline (enter - to clear)', inspection.tagline || '-');
    const adminEmail = await askRequired(rl, 'Administrator email', inspection.adminEmail);
    const discourageSearch = await askYesNo(
      rl,
      'Discourage search engines from indexing this site?',
      inspection.blogPublic === 0,
    );
    const showAvatars = await askYesNo(rl, 'Display avatars?', inspection.showAvatars === 1);
    const yearMonthUploads = await askYesNo(
      rl,
      'Organize uploads into year/month folders?',
      inspection.yearMonthUploads === 1,
    );
    const defaultCategory = interactive && inspection.categories.length
      ? await select({
        message: 'Default post category',
        initialValue: String(inspection.defaultCategory),
        options: inspection.categories.map((category) => ({ value: String(category.id), label: category.name, hint: `ID ${category.id}` })),
      })
      : await askRequired(rl, 'Default post category ID', String(inspection.defaultCategory));
    if (isCancel(defaultCategory)) {
      const error = new Error('Operation cancelled.');
      error.code = 'WITH_SCRIPTS_CANCELLED';
      throw error;
    }
    if (!/^\d+$/.test(defaultCategory)) {
      throw new Error('Default post category ID must be a number.');
    }
    const closeExistingComments = await askYesNo(
      rl,
      'Close comments and pingbacks on existing posts and pages?',
      fresh,
    );
    const configureMedia = await askYesNo(rl, 'Configure the WordPress media sizes?', true);
    const installPlugins = {};
    if (interactive) {
      const selectedPlugins = await multiselect({
        message: 'Choose plugins to install and activate',
        options: profile.plugins.map((plugin) => ({ value: plugin.slug, label: plugin.label })),
        initialValues: profile.plugins.map((plugin) => plugin.slug),
        required: false,
      });
      if (isCancel(selectedPlugins)) {
        const error = new Error('Operation cancelled.');
        error.code = 'WITH_SCRIPTS_CANCELLED';
        throw error;
      }
      for (const plugin of profile.plugins) installPlugins[plugin.slug] = selectedPlugins.includes(plugin.slug);
    } else {
      for (const plugin of profile.plugins) {
        installPlugins[plugin.slug] = await askYesNo(rl, `Install and activate ${plugin.label}?`, true);
      }
    }
    const deleteHello = await askYesNo(rl, 'Delete the Hello Dolly plugin if installed?', fresh);
    const defaultThemes = inspection.themes
      .filter((theme) => !theme.active && /^twentytwenty/i.test(theme.slug))
      .sort((left, right) => right.slug.localeCompare(left.slug));
    const deleteOldDefaultThemes = defaultThemes.length > 1
      ? await askYesNo(rl, 'Delete old inactive default themes while keeping one fallback theme?', false)
      : false;
    const sampleCandidates = [
      inspection.samplePost && { kind: 'post', ...inspection.samplePost },
      inspection.samplePage && { kind: 'page', ...inspection.samplePage },
      inspection.sampleComment && { kind: 'comment', ...inspection.sampleComment },
    ].filter(Boolean);
    let samples = [];
    if (sampleCandidates.length) {
      console.log('\nPossible WordPress sample content:');
      for (const sample of sampleCandidates) {
        console.log(`  ${sample.kind} #${sample.id}: ${sample.title || sample.author}`);
      }
      if (await askYesNo(rl, 'Permanently delete exactly these sample records?', fresh)) {
        samples = sampleCandidates;
      }
    }
    const createSnapshot = !fresh && await askYesNo(
      rl,
      'Create a local DDEV database snapshot before applying changes?',
      true,
    );

    const medium = pixelsFromLayout(inspection.contentSize, profile.media.mediumFallback);
    const large = pixelsFromLayout(inspection.wideSize, profile.media.largeFallback);
    const configuration = {
      profile: profileName,
      samples,
      pages: Object.fromEntries(Object.entries(profile.pages).map(([key, page]) => [key, {
        ...page,
        selection: selections[key],
      }])),
      options: {
        blogname: siteTitle,
        blogdescription: taglineInput === '-' ? '' : taglineInput,
        admin_email: adminEmail,
        timezone_string: 'Europe/Berlin',
        date_format: 'd.m.Y',
        time_format: 'H:i',
        permalink_structure: '/%postname%/',
        default_comment_status: 'closed',
        default_ping_status: 'closed',
        blog_public: discourageSearch ? 0 : 1,
        show_avatars: showAvatars ? 1 : 0,
        uploads_use_yearmonth_folders: yearMonthUploads ? 1 : 0,
      },
      closeExistingComments,
      defaultCategory: Number(defaultCategory),
      activityLogDays: profile.activityLogDays,
      configureActivityLog: installPlugins['aryo-activity-log'],
      media: configureMedia ? {
        medium_size_w: medium,
        medium_size_h: medium,
        large_size_w: large,
        large_size_h: large,
        thumbnail_size_w: profile.media.thumbnail,
        thumbnail_size_h: profile.media.thumbnail,
        thumbnail_crop: profile.media.cropThumbnail ? 1 : 0,
      } : null,
    };

    note([
      `Pages: ${Object.values(selections).join(', ')}`,
      `Language: ${language}`,
      `Media: ${configureMedia ? `${medium}px / ${large}px / ${profile.media.thumbnail}px` : 'unchanged'}`,
      `Plugins: ${profile.plugins.filter((plugin) => installPlugins[plugin.slug]).map((plugin) => plugin.label).join(', ') || 'none'}`,
      `Sample records: ${samples.length ? `${samples.length} permanently deleted` : 'unchanged'}`,
      `Database snapshot: ${createSnapshot ? 'yes' : 'no'}`,
    ].join('\n'), 'Planned local changes');

    if (dryRun) {
      outro('Dry run complete. No WordPress changes were made.');
      return;
    }

    if (!await askYesNo(rl, 'Apply this configuration to the local DDEV site now?', false)) {
      outro('Stopped before making WordPress changes.');
      return;
    }
    rl?.close();

    let snapshotName = '';
    if (createSnapshot) {
      snapshotName = `before-configure-wordpress-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      run('Creating local database snapshot', 'ddev', ['snapshot', `--name=${snapshotName}`]);
    }

    run('Installing and activating the WordPress language', 'ddev', [
      'wp', 'language', 'core', 'install', language, '--activate',
    ]);
    run('Setting minor WordPress core updates', 'ddev', [
      'wp', 'config', 'set', 'WP_AUTO_UPDATE_CORE', 'minor', '--type=constant',
    ]);

    for (const plugin of profile.plugins) {
      if (!installPlugins[plugin.slug]) continue;
      const status = inspection.plugins[plugin.slug];
      if (!status) {
        run(`Installing ${plugin.label}`, 'ddev', ['wp', 'plugin', 'install', plugin.slug, '--activate']);
      } else if (status !== 'active') {
        run(`Activating ${plugin.label}`, 'ddev', ['wp', 'plugin', 'activate', plugin.slug]);
      } else {
        console.log(`\n${plugin.label} is already active.`);
      }
    }

    const result = parseJsonOutput(runCapture(
      'Applying WordPress configuration',
      'ddev',
      ['wp', 'eval', buildConfigurePhp(configuration)],
    ));
    if (inspection.pluginAutoUpdates.length) {
      run('Disabling plugin auto-updates', 'ddev', ['wp', 'plugin', 'auto-updates', 'disable', '--all']);
    } else {
      console.log('\nPlugin auto-updates are already disabled.');
    }

    if (deleteHello && inspection.plugins.hello) {
      if (inspection.plugins.hello === 'active') {
        run('Deactivating Hello Dolly', 'ddev', ['wp', 'plugin', 'deactivate', 'hello']);
      }
      run('Deleting Hello Dolly', 'ddev', ['wp', 'plugin', 'delete', 'hello']);
    }
    if (deleteOldDefaultThemes) {
      for (const theme of defaultThemes.slice(1)) {
        run(`Deleting inactive theme ${theme.name}`, 'ddev', ['wp', 'theme', 'delete', theme.slug]);
      }
    }

    const verification = parseJsonOutput(runCapture(
      'Verifying local WordPress configuration',
      'ddev',
      ['wp', 'eval', inspectPhp],
    ));
    const missingPages = Object.keys(profile.pages).filter(
      (key) => !verification.pages.some((page) => page.marker === key),
    );
    const missingPlugins = profile.plugins
      .filter((plugin) => installPlugins[plugin.slug] && verification.plugins[plugin.slug] !== 'active')
      .map((plugin) => plugin.label);
    const incorrectOptions = Object.entries(configuration.options)
      .filter(([name, value]) => verification.configuredOptions[name] != value)
      .map(([name]) => name);
    const frontPageMismatch = verification.showOnFront !== 'page'
      || verification.pageOnFront !== result.pages.home
      || verification.pageForPosts !== result.pages.blog
      || verification.privacyPage !== result.pages.privacy;
    const mediaMismatch = configureMedia && (
      verification.mediumSize !== medium
      || verification.largeSize !== large
      || verification.thumbnailSize !== profile.media.thumbnail
    );
    const activityMismatch = installPlugins['aryo-activity-log']
      && verification.activityLogDays !== String(profile.activityLogDays);
    const updateMismatch = verification.coreAutoUpdates !== 'minor'
      || verification.pluginAutoUpdates.length > 0;
    if (
      missingPages.length
      || missingPlugins.length
      || incorrectOptions.length
      || frontPageMismatch
      || mediaMismatch
      || activityMismatch
      || updateMismatch
    ) {
      throw new Error([
        'Verification failed.',
        `Missing pages: ${missingPages.join(', ') || 'none'}.`,
        `Inactive plugins: ${missingPlugins.join(', ') || 'none'}.`,
        `Incorrect options: ${incorrectOptions.join(', ') || 'none'}.`,
      ].join(' '));
    }

    log.success('Local WordPress configuration complete.');
    console.log(`  Homepage ID: ${result.pages.home}`);
    console.log(`  Posts page ID: ${result.pages.blog}`);
    console.log(`  Privacy page ID: ${result.pages.privacy}`);
    if (installPlugins['aryo-activity-log']) {
      console.log(`  Activity Log retention: ${profile.activityLogDays} days`);
    }
    console.log('  Plugin auto-updates: disabled');
    console.log('  WordPress core auto-updates: minor releases');
    if (!profile.theme) {
      console.log('  Theme setup: run with-scripts setup-theme when ready');
    }
    if (snapshotName) {
      console.log(`  Restore snapshot if needed: ddev snapshot restore ${snapshotName}`);
    }
    outro('Verification: passed');
  } finally {
    rl?.close();
  }
}

function parseJsonOutput(output) {
  const marker = 'WITH_SCRIPTS_JSON:';
  const index = output.lastIndexOf(marker);
  if (index === -1) {
    throw new Error('WordPress returned an unreadable configuration response.');
  }
  const line = output.slice(index + marker.length).split(/\r?\n/, 1)[0];
  return JSON.parse(line);
}
