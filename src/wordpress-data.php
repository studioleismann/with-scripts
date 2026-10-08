<?php
/** Trusted, database-only WordPress inspection. Never load application PHP. */

function with_scripts_php_literal( array $token ) {
	if ( T_CONSTANT_ENCAPSED_STRING === $token[0] ) {
		$text = substr( $token[1], 1, -1 );
		if ( "'" === $token[1][0] ) {
			return str_replace( array( "\\'", '\\\\' ), array( "'", '\\' ), $text );
		}
		return preg_replace_callback( '/\\\\(?:[nrtvef\\\\$"]|[0-7]{1,3}|x[0-9a-fA-F]{1,2})/', static function ( $match ) {
			$escape = substr( $match[0], 1 );
			$known = array( 'n' => "\n", 'r' => "\r", 't' => "\t", 'v' => "\v", 'e' => "\e", 'f' => "\f", '\\' => '\\', '$' => '$', '"' => '"' );
			return $known[ $escape ] ?? chr( 'x' === $escape[0] ? hexdec( substr( $escape, 1 ) ) : octdec( $escape ) );
		}, $text );
	}
	if ( T_STRING === $token[0] && in_array( strtolower( $token[1] ), array( 'true', 'false' ), true ) ) {
		return 'true' === strtolower( $token[1] );
	}
	throw new RuntimeException( 'Use literal configuration values for database-only WordPress operations.' );
}

function with_scripts_read_config( string $root ): array {
	$file = $root . '/wp-config.php';
	clearstatcache( true, $file );
	$stat = lstat( $file );
	if ( ! $stat || ( $stat['mode'] & 0170000 ) !== 0100000 ) {
		throw new RuntimeException( 'Use a regular wp-config.php without symlinks.' );
	}
	$handle = fopen( $file, 'rb' );
	$opened = fstat( $handle );
	if ( $stat['dev'] !== $opened['dev'] || $stat['ino'] !== $opened['ino'] || $opened['size'] > 1048576 ) {
		throw new RuntimeException( 'wp-config.php changed while reading. Review and retry.' );
	}
	$source = stream_get_contents( $handle );
	fclose( $handle );
	$tokens = array();
	$offset = 0;
	foreach ( token_get_all( $source ) as $token ) {
		$text = is_array( $token ) ? $token[1] : $token;
		if ( ! is_array( $token ) || ! in_array( $token[0], array( T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG ), true ) ) {
			$tokens[] = array( is_array( $token ) ? $token[0] : 0, $text, $offset );
		}
		$offset += strlen( $text );
	}
	$values = array();
	$prefix_token = null;
	$wanted = array( 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'MULTISITE', 'WP_CONTENT_DIR', 'WP_HOME', 'WP_SITEURL' );
	foreach ( $tokens as $index => $token ) {
		$name = null;
		$value = null;
		if ( T_STRING === $token[0] && 'define' === strtolower( $token[1] ) && '(' === ( $tokens[ $index + 1 ][1] ?? '' ) && T_CONSTANT_ENCAPSED_STRING === ( $tokens[ $index + 2 ][0] ?? 0 ) ) {
			$name = with_scripts_php_literal( $tokens[ $index + 2 ] );
			if ( ! in_array( $name, $wanted, true ) ) continue;
			if ( ',' !== ( $tokens[ $index + 3 ][1] ?? '' ) || ')' !== ( $tokens[ $index + 5 ][1] ?? '' ) ) {
				throw new RuntimeException( 'Use one literal definition for ' . $name . ' before running database-only operations.' );
			}
			$value = with_scripts_php_literal( $tokens[ $index + 4 ] );
		} elseif ( T_VARIABLE === $token[0] && '$table_prefix' === $token[1] && '=' === ( $tokens[ $index + 1 ][1] ?? '' ) ) {
			$name = 'table_prefix';
			if ( ';' !== ( $tokens[ $index + 3 ][1] ?? '' ) ) throw new RuntimeException( 'Use a literal table_prefix in wp-config.php.' );
			$prefix_token = $tokens[ $index + 2 ];
			$value = with_scripts_php_literal( $prefix_token );
		}
		if ( null !== $name ) {
			if ( array_key_exists( $name, $values ) ) throw new RuntimeException( 'Ambiguous configuration value: ' . $name );
			$values[ $name ] = $value;
		}
	}
	if ( ! isset( $values['table_prefix'] ) || ! is_string( $values['table_prefix'] ) || ! preg_match( '/^[a-zA-Z0-9_]+$/D', $values['table_prefix'] ) ) throw new RuntimeException( 'Use a literal alphanumeric table_prefix in wp-config.php.' );
	if ( ( $values['MULTISITE'] ?? false ) || ( isset( $values['WP_CONTENT_DIR'] ) && $values['WP_CONTENT_DIR'] !== $root . '/wp-content' ) ) throw new RuntimeException( 'Multisite and custom content directories are unsupported.' );
	return array( $values, $source, $prefix_token );
}

function with_scripts_data_css( array $blocks, string $parent = '' ): array {
	$result = array();
	foreach ( $blocks as $index => $block ) {
		$path = $parent . '/' . $index;
		$attrs = $block['attrs'] ?? array();
		if ( preg_match( '/(?:^|\s)has-custom-css(?:\s|$)/', $attrs['className'] ?? '' ) ) throw new RuntimeException( 'has-custom-css must not be stored in className: ' . $path );
		if ( isset( $attrs['style'] ) && array_key_exists( 'css', $attrs['style'] ) ) $result[] = array( 'path' => $path, 'className' => $attrs['className'] ?? '', 'css' => $attrs['style']['css'] );
		$result = array_merge( $result, with_scripts_data_css( $block['innerBlocks'] ?? array(), $path ) );
	}
	return $result;
}

// Transform serialized data without instantiating objects or changing class names.
function with_scripts_replace_value( string $value, string $pattern, string $replacement, int $depth = 0 ): string {
	if ( $depth > 128 ) throw new RuntimeException( 'Serialized data nesting exceeds the safe limit.' );
	if ( ! preg_match( $pattern, $value ) ) return $value;
	if ( ! preg_match( '/^(?:[aOCsE]:[0-9]+:|[bidrR]:|N;)/', $value ) ) {
		$result = preg_replace( $pattern, $replacement, $value );
		if ( null === $result ) throw new RuntimeException( 'URL replacement failed.' );
		return $result;
	}
	$offset = 0;
	$result = with_scripts_serialized_value( $value, $offset, $pattern, $replacement, $depth + 1 );
	if ( $offset !== strlen( $value ) ) throw new RuntimeException( 'Malformed serialized database value; review it before replacement.' );
	return $result;
}

function with_scripts_serialized_value( string $value, int &$offset, string $pattern, string $replacement, int $depth ): string {
	if ( $depth > 128 ) throw new RuntimeException( 'Serialized data nesting exceeds the safe limit.' );
	$rest = substr( $value, $offset );
	if ( preg_match( '/^(?:N;|[bidirR]:[^;]+;)/', $rest, $match ) ) { $offset += strlen( $match[0] ); return $match[0]; }
	if ( preg_match( '/^([sE]):([0-9]+):"/', $rest, $match ) ) {
		$length = (int) $match[2];
		$offset += strlen( $match[0] );
		$text = substr( $value, $offset, $length );
		if ( strlen( $text ) !== $length || substr( $value, $offset + $length, 2 ) !== '";' ) throw new RuntimeException( 'Invalid serialized string length.' );
		$offset += $length + 2;
		$changed = 's' === $match[1] ? with_scripts_replace_value( $text, $pattern, $replacement, $depth + 1 ) : $text;
		return $match[1] . ':' . strlen( $changed ) . ':"' . $changed . '";';
	}
	if ( preg_match( '/^a:([0-9]+):\{/', $rest, $match ) ) {
		$header = $match[0]; $count = (int) $match[1];
	} elseif ( preg_match( '/^O:([0-9]+):"/', $rest, $match ) ) {
		$start = strlen( $match[0] ) + (int) $match[1];
		if ( ! preg_match( '/^":([0-9]+):\{/', substr( $rest, $start ), $tail ) ) throw new RuntimeException( 'Invalid serialized object.' );
		$header = substr( $rest, 0, $start ) . $tail[0]; $count = (int) $tail[1];
	} elseif ( preg_match( '/^C:([0-9]+):"/', $rest, $match ) ) {
		$start = strlen( $match[0] ) + (int) $match[1];
		if ( ! preg_match( '/^":([0-9]+):\{/', substr( $rest, $start ), $tail ) ) throw new RuntimeException( 'Invalid custom serialized object.' );
		$length = $start + strlen( $tail[0] ) + (int) $tail[1] + 1;
		$serialized = substr( $rest, 0, $length );
		if ( strlen( $serialized ) !== $length || ! str_ends_with( $serialized, '}' ) || preg_match( $pattern, $serialized ) ) throw new RuntimeException( 'Review custom serialized objects before URL replacement.' );
		$offset += $length; return $serialized;
	} else { throw new RuntimeException( 'Unsupported serialized database value.' ); }
	if ( $count > strlen( $rest ) ) throw new RuntimeException( 'Invalid serialized element count.' );
	$offset += strlen( $header ); $result = $header;
	for ( $index = 0; $index < $count * 2; $index++ ) $result .= with_scripts_serialized_value( $value, $offset, $pattern, $replacement, $depth + 1 );
	if ( ( $value[ $offset++ ] ?? '' ) !== '}' ) throw new RuntimeException( 'Invalid serialized array or object.' );
	return $result . '}';
}

// The CLI entry point can be embedded in a trusted SSH/DDEV script unchanged.
if ( isset( $argv[1] ) && 'library' === $argv[1] ) return;
try {
	if ( PHP_VERSION_ID < 80100 ) throw new RuntimeException( 'Use PHP 8.1 or newer for database-only WordPress operations.' );
	$mode = $argv[1] ?? '';
	$local_pull = in_array( $mode, array( 'pull-replace', 'pull-preflight' ), true );
	if ( $local_pull ) $mode = substr( $mode, 5 );
	$root = $argv[2] ?? '';
	if ( ! is_dir( $root ) || realpath( $root ) !== $root ) throw new RuntimeException( 'Use a canonical WordPress document root.' );
	[ $config, $config_source, $prefix_token ] = with_scripts_read_config( $root );
	if ( 'config' === $mode ) {
		$name = $argv[3] ?? '';
		if ( ! in_array( $name, array( 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'table_prefix' ), true ) || ! isset( $config[ $name ] ) || ! is_string( $config[ $name ] ) ) throw new RuntimeException( 'Missing literal database configuration.' );
		echo $config[ $name ]; exit;
	}
	if ( 'prefix' === $mode ) {
		$prefix = $argv[3] ?? '';
		if ( ! preg_match( '/^[a-zA-Z0-9_]+$/D', $prefix ) ) throw new RuntimeException( 'Invalid table prefix.' );
		$updated = substr_replace( $config_source, var_export( $prefix, true ), $prefix_token[2], strlen( $prefix_token[1] ) );
		if ( file_get_contents( $root . '/wp-config.php' ) !== $config_source || is_link( $root . '/wp-config.php' ) ) throw new RuntimeException( 'Configuration changed before updating the prefix.' );
		if ( file_put_contents( $root . '/wp-config.php', $updated ) !== strlen( $updated ) ) throw new RuntimeException( 'Could not update the candidate table prefix.' );
		exit;
	}
	foreach ( array( 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME' ) as $name ) if ( ! isset( $config[ $name ] ) || ! is_string( $config[ $name ] ) ) throw new RuntimeException( 'Missing literal ' . $name . ' in wp-config.php.' );
	if ( ! preg_match( '/^([a-zA-Z0-9_.-]+)(?::([0-9]+))?$/D', $config['DB_HOST'], $host ) ) throw new RuntimeException( 'DB_HOST must use a hostname or hostname:port.' );
	mysqli_report( MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT );
	$db = new mysqli( $host[1], $config['DB_USER'], $config['DB_PASSWORD'], $config['DB_NAME'], isset( $host[2] ) ? (int) $host[2] : 3306 );
	$db->set_charset( 'utf8mb4' );
	$prefix = $config['table_prefix'];
	$tables = array();
	foreach ( $db->query( 'SHOW FULL TABLES' )->fetch_all() as $table ) {
		// Pull only changes the selected site. Push still requires an exclusive database.
		if ( ! str_starts_with( $table[0], $prefix ) ) {
			if ( $local_pull ) continue;
			throw new RuntimeException( 'Shared databases are unsupported for this operation. Review table: ' . $table[0] );
		}
		if ( 'BASE TABLE' !== $table[1] ) throw new RuntimeException( 'WordPress database views are unsupported. Review view: ' . $table[0] );
		if ( ! preg_match( '/^[a-zA-Z0-9_]+$/D', $table[0] ) ) throw new RuntimeException( 'Unsupported WordPress table name: ' . $table[0] );
		$tables[] = $table[0];
	}
	sort( $tables );
	if ( ! in_array( $prefix . 'options', $tables, true ) || ! in_array( $prefix . 'posts', $tables, true ) ) throw new RuntimeException( 'WordPress database tables are missing for prefix "' . $prefix . '". Check the imported table prefix.' );
	$options = array_column( $db->query( "SELECT option_name, option_value FROM `{$prefix}options` WHERE option_name IN ('home','siteurl','stylesheet','template','active_plugins')" )->fetch_all( MYSQLI_ASSOC ), 'option_value', 'option_name' );
	if ( 'preflight' === $mode ) {
		if ( ( $options['home'] ?? '' ) !== ( $argv[3] ?? '' ) || ( $options['siteurl'] ?? '' ) !== ( $argv[3] ?? '' ) || ( isset( $config['WP_HOME'] ) && $config['WP_HOME'] !== $argv[3] ) || ( isset( $config['WP_SITEURL'] ) && $config['WP_SITEURL'] !== $argv[3] ) ) throw new RuntimeException( 'Target URL does not match the installed WordPress database.' );
		echo json_encode( array( 'root' => $root, 'home' => $options['home'], 'prefix' => $prefix, 'tables' => $tables, 'php' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION, 'configHash' => hash( 'sha256', $config_source ) ), JSON_THROW_ON_ERROR ); exit;
	}
	if ( 'permalink' === $mode ) {
		$page = $db->query( "SELECT ID FROM `{$prefix}posts` WHERE post_type='page' AND post_status='publish' ORDER BY ID LIMIT 1" )->fetch_assoc();
		if ( $page ) echo rtrim( $options['home'], '/' ) . '/?page_id=' . (int) $page['ID'];
		exit;
	}
	if ( 'settings' === $mode ) {
		$manifest = json_decode( file_get_contents( $argv[3] ), true, 512, JSON_THROW_ON_ERROR );
		if ( $options['home'] !== $argv[4] || $options['siteurl'] !== $argv[4] || $options['stylesheet'] !== $manifest['theme'] || $options['template'] !== $manifest['template'] || unserialize( $options['active_plugins'], array( 'allowed_classes' => false ) ) !== $manifest['plugins'] ) throw new RuntimeException( 'Imported WordPress settings differ.' );
		$version = null;
		$tokens = token_get_all( file_get_contents( $root . '/wp-includes/version.php' ) );
		$tokens = array_values( array_filter( $tokens, static fn( $token ) => ! is_array( $token ) || ! in_array( $token[0], array( T_WHITESPACE, T_COMMENT, T_DOC_COMMENT ), true ) ) );
		foreach ( $tokens as $index => $token ) if ( is_array( $token ) && T_VARIABLE === $token[0] && '$wp_version' === $token[1] && '=' === ( $tokens[ $index + 1 ] ?? '' ) && ';' === ( $tokens[ $index + 3 ] ?? '' ) ) $version = with_scripts_php_literal( $tokens[ $index + 2 ] );
		if ( $version !== $argv[5] ) throw new RuntimeException( 'Candidate WordPress version differs.' );
		foreach ( array_unique( array( $manifest['theme'], $manifest['template'] ) ) as $slug ) if ( ! preg_match( '/^[a-zA-Z0-9_-]+$/D', $slug ) || ! is_file( $root . '/wp-content/themes/' . $slug . '/style.css' ) ) throw new RuntimeException( 'Active theme is missing.' );
		foreach ( $manifest['plugins'] as $plugin ) if ( ! preg_match( '/^[a-zA-Z0-9_.\/-]+\.php$/D', $plugin ) || in_array( '..', explode( '/', $plugin ), true ) || ! is_file( $root . '/wp-content/plugins/' . $plugin ) ) throw new RuntimeException( 'Active plugin is missing.' );
		exit;
	}
	if ( ! class_exists( 'WP_Block_Parser', false ) ) require __DIR__ . '/wordpress-block-parser.php';
	$parser = new WP_Block_Parser();
	$posts = $db->query( "SELECT ID, post_parent, post_type, post_status, post_modified_gmt, post_content FROM `{$prefix}posts` ORDER BY ID" )->fetch_all( MYSQLI_ASSOC );
	$inventory = array();
	foreach ( $posts as $post ) {
		$content = $post['post_content']; unset( $post['post_content'] );
		$inventory[] = $post + array( 'before' => hash( 'sha256', $content ), 'after' => hash( 'sha256', $content ), 'css' => with_scripts_data_css( $parser->parse( $content ) ) );
	}
	if ( 'inspect' === $mode ) {
		$rows = array();
		foreach ( $tables as $table ) $rows[ $table ] = (int) $db->query( 'SELECT COUNT(*) FROM `' . $table . '`' )->fetch_row()[0];
		echo json_encode( array( 'tables' => $tables, 'tableRows' => $rows, 'posts' => $inventory ), JSON_THROW_ON_ERROR ); exit;
	}
	if ( 'verify' === $mode ) {
		$manifest = json_decode( file_get_contents( $argv[3] ), true, 512, JSON_THROW_ON_ERROR );
		$column = $argv[4] ?? 'after';
		if ( ! in_array( $column, array( 'before', 'after' ), true ) ) throw new RuntimeException( 'Invalid verification mode.' );
		$expected_tables = $manifest['tables']; sort( $expected_tables );
		if ( $tables !== $expected_tables || count( $inventory ) !== count( $manifest['posts'] ) ) throw new RuntimeException( 'Imported tables or content row count differ from the manifest.' );
		foreach ( $inventory as $index => $post ) {
			$expected = $manifest['posts'][ $index ];
			if ( $post['before'] !== $expected[ $column ] || $post['css'] !== $expected['css'] ) throw new RuntimeException( 'Imported content or protected CSS differs: ' . $post['ID'] );
			foreach ( array( 'ID', 'post_parent', 'post_type', 'post_status', 'post_modified_gmt' ) as $field ) if ( $post[ $field ] !== $expected[ $field ] ) throw new RuntimeException( 'Imported post metadata differs: ' . $post['ID'] );
		}
		echo 'Verified content, revisions, autosaves and protected CSS: ' . count( $inventory ) . " rows.\n"; exit;
	}
	if ( 'replace' !== $mode ) throw new RuntimeException( 'Unknown database operation.' );
	$settings = json_decode( base64_decode( $argv[3], true ), true, 512, JSON_THROW_ON_ERROR );
	$updates = array();
	// Prepare every change and inventory all revisions/autosaves before the first write.
	foreach ( $tables as $table ) {
		$columns = $db->query( 'SHOW COLUMNS FROM `' . $table . '`' )->fetch_all( MYSQLI_ASSOC );
		$keys = array_column( array_filter( $columns, static fn( $column ) => 'PRI' === $column['Key'] ), 'Field' );
		$text_columns = array_column( array_filter( $columns, static fn( $column ) => 'guid' !== $column['Field'] && preg_match( '/(?:char|text|blob|json)/i', $column['Type'] ) ), 'Field' );
		foreach ( array_merge( $keys, $text_columns ) as $column ) if ( ! preg_match( '/^[a-zA-Z0-9_]+$/D', $column ) ) throw new RuntimeException( 'Unsupported database column name.' );
		if ( ! $text_columns ) continue;
		foreach ( $db->query( 'SELECT * FROM `' . $table . '`' )->fetch_all( MYSQLI_ASSOC ) as $row ) {
			$changed = array();
			foreach ( $text_columns as $column ) {
				if ( null === $row[ $column ] ) continue;
				$updated = with_scripts_replace_value( $row[ $column ], $settings['pattern'], $settings['replacement'] );
				if ( $updated !== $row[ $column ] ) $changed[ $column ] = $updated;
			}
			if ( ! $changed ) continue;
			if ( ! $keys ) throw new RuntimeException( 'URL replacement requires a primary key: ' . $table );
			if ( $table === $prefix . 'posts' && isset( $changed['post_content'] ) && with_scripts_data_css( $parser->parse( $row['post_content'] ) ) !== with_scripts_data_css( $parser->parse( $changed['post_content'] ) ) ) throw new RuntimeException( 'URL replacement would change protected Custom CSS.' );
			$updates[] = array( $table, $keys, $row, $changed );
		}
	}
	foreach ( $db->query( 'SHOW TABLE STATUS' )->fetch_all( MYSQLI_ASSOC ) as $table ) if ( in_array( $table['Name'], $tables, true ) && 'InnoDB' !== $table['Engine'] ) throw new RuntimeException( 'Use InnoDB tables for transactional URL replacement. Review table: ' . $table['Name'] );
	$expected_posts = $posts;
	$db->begin_transaction();
	try {
		if ( $db->query( "SELECT ID, post_parent, post_type, post_status, post_modified_gmt, post_content FROM `{$prefix}posts` ORDER BY ID FOR UPDATE" )->fetch_all( MYSQLI_ASSOC ) !== $posts ) throw new RuntimeException( 'Content or revisions changed before URL replacement. Retry after editing has stopped.' );
		foreach ( $updates as [ $table, $keys, $row, $changed ] ) {
			$where = implode( ' AND ', array_map( static fn( $key ) => '`' . $key . '` <=> ?', $keys ) );
			$key_values = array_map( static fn( $key ) => $row[ $key ], $keys );
			$read = $db->prepare( 'SELECT * FROM `' . $table . '` WHERE ' . $where . ' FOR UPDATE' );
			$read->execute( $key_values );
			$current = $read->get_result()->fetch_assoc();
			if ( null === $current || array_map( static fn( $value ) => null === $value ? null : (string) $value, $current ) !== $row ) throw new RuntimeException( 'Database row changed during URL replacement. Retry after editing has stopped.' );
			$write = $db->prepare( 'UPDATE `' . $table . '` SET ' . implode( ', ', array_map( static fn( $column ) => '`' . $column . '` = ?', array_keys( $changed ) ) ) . ' WHERE ' . $where );
			$write->execute( array_merge( array_values( $changed ), $key_values ) );
			$read->execute( array_map( static fn( $key ) => $changed[ $key ] ?? $row[ $key ], $keys ) );
			$current = $read->get_result()->fetch_assoc();
			if ( null === $current || array_map( static fn( $value ) => null === $value ? null : (string) $value, $current ) !== array_replace( $row, $changed ) ) throw new RuntimeException( 'URL replacement verification failed; changes rolled back.' );
			if ( $table === $prefix . 'posts' ) {
				foreach ( $expected_posts as $index => $post ) if ( $post['ID'] === $row['ID'] ) $expected_posts[ $index ] = array_replace( $post, array_intersect_key( $changed, $post ) );
				if ( isset( $changed['post_content'] ) && with_scripts_data_css( $parser->parse( $current['post_content'] ) ) !== with_scripts_data_css( $parser->parse( $row['post_content'] ) ) ) throw new RuntimeException( 'Protected Custom CSS changed; URL replacement rolled back.' );
			}
			if ( $db->query( "SELECT ID, post_parent, post_type, post_status, post_modified_gmt, post_content FROM `{$prefix}posts` ORDER BY ID" )->fetch_all( MYSQLI_ASSOC ) !== $expected_posts ) throw new RuntimeException( 'Unexpected content or revision changes; URL replacement rolled back.' );
		}
		$db->commit();
	} catch ( Throwable $error ) { $db->rollback(); throw $error; }
	echo 'Verified database-only URL replacement: ' . count( $updates ) . " rows.\n";
} catch ( Throwable $error ) {
	fwrite( STDERR, 'Error: ' . ( $error instanceof mysqli_sql_exception ? 'Database-only operation failed. Check the literal database configuration and database access.' : $error->getMessage() ) . "\n" );
	exit( 1 );
}
