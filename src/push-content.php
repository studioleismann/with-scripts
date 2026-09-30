<?php
/** Read-only content manifest for a WordPress export and its imported copy. */

function with_scripts_content_css( array $blocks, string $parent = '' ): array {
	$result = array();
	foreach ( $blocks as $index => $block ) {
		$path  = $parent . '/' . $index;
		$attrs = $block['attrs'] ?? array();
		if ( preg_match( '/(?:^|\s)has-custom-css(?:\s|$)/', $attrs['className'] ?? '' ) ) {
			throw new RuntimeException( 'has-custom-css must not be stored in className: ' . $path );
		}
		if ( isset( $attrs['style'] ) && array_key_exists( 'css', $attrs['style'] ) ) {
			$result[] = array( 'path' => $path, 'className' => $attrs['className'] ?? '', 'css' => $attrs['style']['css'] );
		}
		$result = array_merge( $result, with_scripts_content_css( $block['innerBlocks'] ?? array(), $path ) );
	}
	return $result;
}

global $wpdb;
$mode = $args[0] ?? 'inspect';
if ( 'inspect' === $mode ) {
	$settings = json_decode( base64_decode( $args[1] ), true, 512, JSON_THROW_ON_ERROR );
	if ( is_multisite() || get_option( 'home' ) !== get_option( 'siteurl' ) ) {
		throw new RuntimeException( 'Only single-site WordPress installed at its home URL is supported.' );
	}
	$manifest = array(
		'home' => get_option( 'home' ), 'siteurl' => get_option( 'siteurl' ),
		'version' => get_bloginfo( 'version' ), 'php' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
		'prefix' => $wpdb->prefix, 'theme' => get_option( 'stylesheet' ), 'template' => get_option( 'template' ),
		'plugins' => get_option( 'active_plugins' ), 'posts' => array(),
	);
	$manifest['tables'] = array();
	$manifest['tableRows'] = array();
	foreach ( $wpdb->get_results( 'SHOW FULL TABLES', ARRAY_N ) as $table ) {
		if ( str_starts_with( $table[0], $wpdb->prefix ) ) {
			if ( 'BASE TABLE' !== $table[1] || ! preg_match( '/^[a-zA-Z0-9_]+$/', $table[0] ) ) {
				throw new RuntimeException( 'Unsupported database table or view.' );
			}
			$manifest['tables'][] = $table[0];
			$manifest['tableRows'][ $table[0] ] = (int) $wpdb->get_var( 'SELECT COUNT(*) FROM `' . $table[0] . '`' );
		}
	}
	// Include every published/draft row, revision and autosave; never serialize blocks.
	foreach ( $wpdb->get_results( "SELECT ID, post_parent, post_type, post_status, post_modified_gmt, post_content FROM {$wpdb->posts} ORDER BY ID", ARRAY_A ) as $post ) {
		$original = $post['post_content'];
		$prepared = preg_replace( $settings['pattern'], $settings['replacement'], $original );
		if ( null === $prepared ) {
			throw new RuntimeException( 'Invalid export URL expression.' );
		}
		$css = with_scripts_content_css( parse_blocks( $original ) );
		if ( $css !== with_scripts_content_css( parse_blocks( $prepared ) ) ) {
			throw new RuntimeException( 'Export would change protected CSS on post ' . $post['ID'] );
		}
		unset( $post['post_content'] );
		$manifest['posts'][] = $post + array( 'before' => hash( 'sha256', $original ), 'after' => hash( 'sha256', $prepared ), 'css' => $css );
	}
	if ( $wpdb->last_error ) {
		throw new RuntimeException( 'Could not read all WordPress content.' );
	}
	echo json_encode( $manifest, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES );
} elseif ( 'verify' === $mode ) {
	$manifest = json_decode( file_get_contents( $args[1] ), true, 512, JSON_THROW_ON_ERROR );
	$column = $args[2] ?? 'after';
	if ( ! in_array( $column, array( 'before', 'after' ), true ) ) {
		throw new RuntimeException( 'Invalid verification mode.' );
	}
	$tables = $wpdb->get_col( 'SHOW TABLES' );
	$expected_tables = $manifest['tables'];
	sort( $tables );
	sort( $expected_tables );
	if ( $wpdb->last_error || $tables !== $expected_tables ) {
		throw new RuntimeException( 'Imported database tables differ from the manifest, including plugin tables.' );
	}
	$posts = $wpdb->get_results( "SELECT ID, post_parent, post_type, post_status, post_modified_gmt, post_content FROM {$wpdb->posts} ORDER BY ID", ARRAY_A );
	if ( $wpdb->last_error || count( $posts ) !== count( $manifest['posts'] ) ) {
		throw new RuntimeException( 'Imported content row count differs from the manifest.' );
	}
	foreach ( $posts as $index => $post ) {
		$expected = $manifest['posts'][ $index ];
		$content = $post['post_content'];
		unset( $post['post_content'] );
		foreach ( $post as $key => $value ) {
			if ( $value !== $expected[ $key ] ) {
				throw new RuntimeException( 'Imported post metadata differs: ' . $post['ID'] );
			}
		}
		if ( hash( 'sha256', $content ) !== $expected[ $column ] || with_scripts_content_css( parse_blocks( $content ) ) !== $expected['css'] ) {
			throw new RuntimeException( 'Imported content or protected CSS differs: ' . $post['ID'] );
		}
	}
	echo 'Verified content, revisions, autosaves and protected CSS: ' . count( $posts ) . " rows.\n";
} elseif ( 'settings' === $mode ) {
	$manifest = json_decode( file_get_contents( $args[1] ), true, 512, JSON_THROW_ON_ERROR );
	$home = $wpdb->get_var( "SELECT option_value FROM {$wpdb->options} WHERE option_name='home'" );
	$site = $wpdb->get_var( "SELECT option_value FROM {$wpdb->options} WHERE option_name='siteurl'" );
	if ( $home !== $args[2] || $site !== $args[2] || get_bloginfo( 'version' ) !== $args[3] || get_option( 'stylesheet' ) !== $manifest['theme'] || get_option( 'template' ) !== $manifest['template'] || get_option( 'active_plugins' ) !== $manifest['plugins'] || realpath( ABSPATH ) !== realpath( $args[4] ) ) {
		throw new RuntimeException( 'Imported WordPress settings or bootstrap path differ.' );
	}
} else {
	throw new RuntimeException( 'Unknown content audit mode.' );
}
