#!/bin/sh

# Apply a repository-generated WordPress component artifact as a recoverable transaction.

set -eu

mode=${1-}
wordpress_root=${2-}
run_key=${3-}
manifest_name=.with-deploy-manifest
manifest_version=with-deploy-manifest-v1

fail() {
	printf 'Deployment error: %s\n' "$1" >&2
	exit 1
}

validate_component() (
	type=$1
	component=$2

	case "$type" in
		directory|file) ;;
		*) fail "Invalid component type: $type" ;;
	esac

	case "$component" in
		wp-content/themes/*|wp-content/plugins/*|wp-content/mu-plugins/*) ;;
		*) fail "Unsupported component path: $component" ;;
	esac

	remainder=${component#wp-content/}
	component_root=${remainder%%/*}
	component_name=${remainder#*/}

	case "$component_root" in
		themes|plugins|mu-plugins) ;;
		*) fail "Unsupported component root: $component" ;;
	esac

	case "$component_name" in
		''|*/*|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
			fail "Unsafe component name: $component"
			;;
	esac

	case "$type:$component_root:$component_name" in
		file:themes:*)
			fail "Single-file components are not supported in themes: $component"
			;;
		file:*:*.php) ;;
		file:*:*)
			fail "Single-file plugin components must be PHP files: $component"
			;;
	esac

	[ "$component" = "wp-content/$component_root/$component_name" ] ||
		fail "Component path is not a first-level WordPress entry: $component"
)

validate_manifest() (
	manifest_path=$1

	[ -f "$manifest_path" ] || fail "Manifest is missing: $manifest_path"
	[ ! -L "$manifest_path" ] || fail "Manifest cannot be a symbolic link: $manifest_path"

	line_number=0
	component_count=0
	seen_components='|'
	tab=$(printf '\t')

	while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
		line_number=$((line_number + 1))

		if [ "$line_number" -eq 1 ]; then
			[ "$type" = "$manifest_version" ] && [ -z "$component$extra" ] ||
				fail "Unsupported manifest version: $manifest_path"
			continue
		fi

		[ -n "$type" ] && [ -n "$component" ] && [ -z "$extra" ] ||
			fail "Malformed manifest entry on line $line_number: $manifest_path"

		validate_component "$type" "$component"

		case "$seen_components" in
			*"|$component|"*) fail "Duplicate component in manifest: $component" ;;
		esac

		seen_components="$seen_components$component|"
		component_count=$((component_count + 1))
	done < "$manifest_path"

	[ "$line_number" -gt 0 ] || fail "Manifest is empty: $manifest_path"
	[ "$component_count" -gt 0 ] || fail "Manifest has no components: $manifest_path"
)

manifest_has_component() (
	manifest_path=$1
	requested_component=$2
	tab=$(printf '\t')

	while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
		if [ "$component" = "$requested_component" ]; then
			return 0
		fi
	done < "$manifest_path"

	return 1
)

assert_component_type() (
	type=$1
	target=$2

	[ ! -L "$target" ] || fail "Component target cannot be a symbolic link: $target"

	case "$type" in
		directory) [ -d "$target" ] || fail "Component directory is missing: $target" ;;
		file) [ -f "$target" ] || fail "Component file is missing: $target" ;;
	esac
)

remove_own_maintenance_file() (
	maintenance_path=$wordpress_root/.maintenance
	maintenance_marker=with-deploy-$run_key

	if [ -e "$maintenance_path" ] || [ -L "$maintenance_path" ]; then
		[ -f "$maintenance_path" ] && [ ! -L "$maintenance_path" ] ||
			fail "The maintenance path is not a regular file."

		maintenance_content=$(cat "$maintenance_path")

		case "$maintenance_content" in
			*"$maintenance_marker"*) rm -f "$maintenance_path" ;;
			*) fail "Refusing to remove a maintenance file owned by another process." ;;
		esac
	fi
)

validate_environment() {
	[ -n "$mode" ] && [ -n "$wordpress_root" ] && [ -n "$run_key" ] ||
		fail 'Mode, WordPress root, and run key are required.'
	newline='
'
	carriage_return=$(printf '\r')
	tab=$(printf '\t')

	case "$wordpress_root" in
		/*) ;;
		*) fail 'WORDPRESS_ROOT must be an absolute path.' ;;
	esac

	case "$wordpress_root" in
		/|*/|*//*|*/./*|*/../*|*/.|*/..|*"$newline"*|*"$carriage_return"*|*"$tab"*)
			fail 'WORDPRESS_ROOT is not a safe canonical directory path.'
			;;
	esac

	run_id=${run_key%%-*}
	run_attempt=${run_key#*-}

	[ "$run_id-$run_attempt" = "$run_key" ] || fail 'The deployment run key is invalid.'

	case "$run_id" in
		''|*[!0-9]*) fail 'The deployment run ID must be numeric.' ;;
	esac

	case "$run_attempt" in
		''|*[!0-9]*) fail 'The deployment run attempt must be numeric.' ;;
	esac

	for required_command in cat find mkdir mv rm sh tar test; do
		command -v "$required_command" >/dev/null 2>&1 ||
			fail "Required command is unavailable: $required_command"
	done

	[ ! -L "$wordpress_root" ] || fail 'WORDPRESS_ROOT cannot be a symbolic link.'
	[ -d "$wordpress_root" ] || fail 'WORDPRESS_ROOT does not exist.'
	[ -f "$wordpress_root/wp-load.php" ] || fail 'WORDPRESS_ROOT does not contain wp-load.php.'
	[ -d "$wordpress_root/wp-admin" ] || fail 'WORDPRESS_ROOT does not contain wp-admin.'
	[ -d "$wordpress_root/wp-includes" ] || fail 'WORDPRESS_ROOT does not contain wp-includes.'
	[ -d "$wordpress_root/wp-content" ] || fail 'WORDPRESS_ROOT does not contain wp-content.'
	[ ! -L "$wordpress_root/wp-content" ] || fail 'wp-content cannot be a symbolic link.'

	wp_content=$wordpress_root/wp-content

	for component_root in themes plugins mu-plugins; do
		[ ! -L "$wp_content/$component_root" ] ||
			fail "WordPress component root cannot be a symbolic link: $component_root"
	done

	workspace=$wp_content/.with-deploy-$run_key
	canonical_manifest=$wp_content/$manifest_name
	maintenance_file=$wordpress_root/.maintenance

	[ "$workspace" = "$wp_content/.with-deploy-$run_key" ] ||
		fail 'The transaction workspace path is invalid.'
}

validate_previous_state() (
	if [ -e "$canonical_manifest" ] || [ -L "$canonical_manifest" ]; then
		validate_manifest "$canonical_manifest"
		tab=$(printf '\t')

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file) assert_component_type "$type" "$wordpress_root/$component" ;;
			esac
		done < "$canonical_manifest"
	fi
)

rollback_transaction() {
	set +e
	rollback_failed=0
	new_manifest=$workspace/new-manifest
	old_manifest=$workspace/old-manifest
	candidate_root=$workspace/candidate/payload
	rollback_root=$workspace/rollback
	failed_root=$workspace/failed

	if [ ! -d "$workspace" ] || [ -L "$workspace" ]; then
		printf 'Rollback error: transaction workspace is unavailable.\n' >&2
		return 1
	fi

	if [ ! -e "$maintenance_file" ] && [ ! -L "$maintenance_file" ]; then
		(
			set -C
			printf '<?php $upgrading = time(); /* with-deploy-%s */\n' "$run_key" > "$maintenance_file"
		) 2>/dev/null || rollback_failed=1
	fi

	if [ -f "$maintenance_file" ] && [ ! -L "$maintenance_file" ]; then
		maintenance_content=$(cat "$maintenance_file" 2>/dev/null)

		case "$maintenance_content" in
			*"with-deploy-$run_key"*) ;;
			*)
				printf 'Rollback error: maintenance file belongs to another process.\n' >&2
				rollback_failed=1
				;;
		esac
	else
		printf 'Rollback error: maintenance mode could not be acquired safely.\n' >&2
		rollback_failed=1
	fi

	if [ -f "$new_manifest" ]; then
		tab=$(printf '\t')

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					candidate=$candidate_root/$component
					target=$wordpress_root/$component
					failed_target=$failed_root/$component

					if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
						if [ -e "$target" ] || [ -L "$target" ]; then
							mkdir -p "${failed_target%/*}" || rollback_failed=1
							mv "$target" "$failed_target" || rollback_failed=1
						fi
					fi
					;;
			esac
		done < "$new_manifest"
	fi

	if [ -f "$workspace/touch-components" ]; then
		tab=$(printf '\t')

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					backup=$rollback_root/$component
					target=$wordpress_root/$component

					if [ -e "$backup" ] || [ -L "$backup" ]; then
						if [ -e "$target" ] || [ -L "$target" ]; then
							printf 'Rollback error: target still exists before restore: %s\n' "$component" >&2
							rollback_failed=1
						else
							mkdir -p "${target%/*}" || rollback_failed=1
							mv "$backup" "$target" || rollback_failed=1
						fi
					fi
					;;
			esac
		done < "$workspace/touch-components"
	fi

	if [ -e "$rollback_root/$manifest_name" ] || [ -L "$rollback_root/$manifest_name" ]; then
		if [ -e "$canonical_manifest" ] || [ -L "$canonical_manifest" ]; then
			mkdir -p "$failed_root" || rollback_failed=1
			mv "$canonical_manifest" "$failed_root/$manifest_name" || rollback_failed=1
		fi

		mv "$rollback_root/$manifest_name" "$canonical_manifest" || rollback_failed=1
	elif [ -f "$workspace/old-manifest-absent" ]; then
		if [ -e "$canonical_manifest" ] || [ -L "$canonical_manifest" ]; then
			mkdir -p "$failed_root" || rollback_failed=1
			mv "$canonical_manifest" "$failed_root/$manifest_name" || rollback_failed=1
		fi
	elif [ -f "$old_manifest" ]; then
		if [ ! -f "$canonical_manifest" ] ||
			[ "$(cat "$canonical_manifest" 2>/dev/null)" != "$(cat "$old_manifest" 2>/dev/null)" ]; then
			printf 'Rollback error: previous manifest backup is missing.\n' >&2
			rollback_failed=1
		fi
	fi

	if [ "$rollback_failed" -eq 0 ]; then
		if [ -f "$old_manifest" ]; then
			if ! validate_manifest "$canonical_manifest"; then
				rollback_failed=1
			elif [ "$(cat "$canonical_manifest")" != "$(cat "$old_manifest")" ]; then
				printf 'Rollback error: restored manifest does not match the previous manifest.\n' >&2
				rollback_failed=1
			else
				tab=$(printf '\t')

				while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
					case "$type" in
						directory|file)
							if ! assert_component_type "$type" "$wordpress_root/$component"; then
								rollback_failed=1
							fi
							;;
					esac
				done < "$old_manifest"
			fi
		elif [ -e "$canonical_manifest" ] || [ -L "$canonical_manifest" ]; then
			printf 'Rollback error: release manifest remains after bootstrap rollback.\n' >&2
			rollback_failed=1
		fi
	fi

	if [ "$rollback_failed" -eq 0 ]; then
		remove_own_maintenance_file || rollback_failed=1
	fi

	if [ "$rollback_failed" -eq 0 ]; then
		rm -rf "$workspace" || rollback_failed=1
	fi

	set -e
	if [ "$rollback_failed" -eq 0 ]; then
		return 0
	fi
	return 1
}

validate_environment

case "$mode" in
	preflight)
		[ -w "$wp_content" ] || fail 'wp-content is not writable by the deployment account.'
		[ ! -e "$workspace" ] && [ ! -L "$workspace" ] ||
			fail "Transaction workspace already exists: $workspace"
		[ ! -e "$maintenance_file" ] && [ ! -L "$maintenance_file" ] ||
			fail 'WordPress is already in filesystem maintenance mode.'
		validate_previous_state
		printf 'Remote preflight passed.\n'
		;;

	create)
		[ -w "$wp_content" ] || fail 'wp-content is not writable by the deployment account.'
		[ ! -e "$workspace" ] && [ ! -L "$workspace" ] ||
			fail "Transaction workspace already exists: $workspace"
		[ ! -e "$maintenance_file" ] && [ ! -L "$maintenance_file" ] ||
			fail 'WordPress entered filesystem maintenance mode after preflight.'
		validate_previous_state
		umask 077
		mkdir "$workspace"
		printf 'Created transaction workspace.\n'
		;;

	prepare)
		[ -d "$workspace" ] && [ ! -L "$workspace" ] ||
			fail 'Transaction workspace is unavailable.'
		artifact=$workspace/artifact.tar.gz
		candidate=$workspace/candidate
		archive_entries=$workspace/archive-entries
		new_manifest=$workspace/new-manifest
		old_manifest=$workspace/old-manifest

		[ -f "$artifact" ] && [ ! -L "$artifact" ] || fail 'Uploaded artifact is unavailable.'
		[ ! -e "$candidate" ] && [ ! -L "$candidate" ] || fail 'Candidate path already exists.'
		tar -tzf "$artifact" > "$archive_entries"

		while IFS= read -r archive_entry || [ -n "$archive_entry" ]; do
			trimmed_entry=${archive_entry%/}

			case "$trimmed_entry" in
				"$manifest_name"|payload|payload/*) ;;
				*) fail "Unexpected deployment artifact entry: $archive_entry" ;;
			esac

			case "$trimmed_entry" in
				/*|..|../*|*/..|*/../*|*\\*) fail "Unsafe deployment artifact entry: $archive_entry" ;;
			esac
		done < "$archive_entries"

		mkdir "$candidate"
		tar -xzf "$artifact" -C "$candidate"
		find "$candidate" -type l -print > "$workspace/symbolic-links"
		[ ! -s "$workspace/symbolic-links" ] || fail 'Candidate packages cannot contain symbolic links.'
		find "$candidate" ! -type d ! -type f ! -type l -print > "$workspace/special-files"
		[ ! -s "$workspace/special-files" ] ||
			fail 'Candidate packages cannot contain special filesystem entries.'
		validate_manifest "$candidate/$manifest_name"
		cat "$candidate/$manifest_name" > "$new_manifest"

		if [ -e "$canonical_manifest" ] || [ -L "$canonical_manifest" ]; then
			validate_manifest "$canonical_manifest"
			cat "$canonical_manifest" > "$old_manifest"
		else
			: > "$workspace/old-manifest-absent"
		fi

		: > "$workspace/touch-components"
		: > "$workspace/removed-components"
		tab=$(printf '\t')

		if [ -f "$old_manifest" ]; then
			while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
				case "$type" in
					directory|file)
						assert_component_type "$type" "$wordpress_root/$component"
						printf '%s\t%s\n' "$type" "$component" >> "$workspace/touch-components"

						if ! manifest_has_component "$new_manifest" "$component"; then
							printf '%s\t%s\n' "$type" "$component" >> "$workspace/removed-components"
						fi
						;;
				esac
			done < "$old_manifest"
		fi

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					assert_component_type "$type" "$candidate/payload/$component"

					if [ "$type" = 'directory' ]; then
						find "$candidate/payload/$component" -type f -print > "$workspace/component-files"
						[ -s "$workspace/component-files" ] ||
							fail "Candidate component is empty: $component"
					fi

					if [ ! -f "$old_manifest" ] || ! manifest_has_component "$old_manifest" "$component"; then
						printf '%s\t%s\n' "$type" "$component" >> "$workspace/touch-components"
					fi
					;;
			esac
		done < "$new_manifest"

		: > "$workspace/prepared"
		printf 'Prepared component transaction:\n'
		cat "$workspace/touch-components"
		;;

	switch)
		[ -d "$workspace" ] && [ ! -L "$workspace" ] ||
			fail 'Transaction workspace is unavailable.'
		[ -f "$workspace/prepared" ] || fail 'Transaction has not been prepared.'
		[ ! -e "$maintenance_file" ] && [ ! -L "$maintenance_file" ] ||
			fail 'WordPress entered filesystem maintenance mode before the switch.'
		validate_manifest "$workspace/new-manifest"

		if [ -f "$workspace/old-manifest" ]; then
			validate_manifest "$workspace/old-manifest"
		fi

		candidate_root=$workspace/candidate/payload
		rollback_root=$workspace/rollback
		mkdir "$rollback_root"
		printf '<?php $upgrading = time(); /* with-deploy-%s */\n' "$run_key" > "$workspace/maintenance"
		maintenance_acquired=0

		on_switch_exit() {
			switch_status=$1
			trap - 0 1 2 15

			if [ "$switch_status" -ne 0 ] && [ "$maintenance_acquired" -eq 1 ]; then
				if rollback_transaction; then
					printf 'The failed switch was rolled back.\n' >&2
				else
					printf 'Critical: automatic switch rollback failed.\n' >&2
					switch_status=1
				fi
			fi

			exit "$switch_status"
		}

		trap 'exit 129' 1
		trap 'exit 130' 2
		trap 'exit 143' 15
		trap 'on_switch_exit $?' 0
		maintenance_acquired=1

		if ! (
			set -C
			cat "$workspace/maintenance" > "$maintenance_file"
		) 2>/dev/null; then
			maintenance_acquired=0
			fail 'WordPress entered filesystem maintenance mode before the switch.'
		fi

		rm -f "$workspace/maintenance"
		tab=$(printf '\t')

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					target=$wordpress_root/$component
					backup=$rollback_root/$component

					if [ -e "$target" ] || [ -L "$target" ]; then
						mkdir -p "${backup%/*}"
						mv "$target" "$backup"
					fi
					;;
			esac
		done < "$workspace/touch-components"

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					candidate_component=$candidate_root/$component
					target=$wordpress_root/$component
					mkdir -p "${target%/*}"
					mv "$candidate_component" "$target"
					;;
			esac
		done < "$workspace/new-manifest"

		if [ -e "$canonical_manifest" ] || [ -L "$canonical_manifest" ]; then
			mv "$canonical_manifest" "$rollback_root/$manifest_name"
		fi

		mv "$workspace/candidate/$manifest_name" "$canonical_manifest"

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file) assert_component_type "$type" "$wordpress_root/$component" ;;
			esac
		done < "$workspace/new-manifest"

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					[ ! -e "$wordpress_root/$component" ] && [ ! -L "$wordpress_root/$component" ] ||
						fail "Removed component remains active: $component"
					;;
			esac
		done < "$workspace/removed-components"

		[ "$(cat "$canonical_manifest")" = "$(cat "$workspace/new-manifest")" ] ||
			fail 'Canonical component manifest does not match the release.'
		: > "$workspace/switched"
		remove_own_maintenance_file
		maintenance_acquired=0
		trap - 0 1 2 15
		printf 'Component switch completed.\n'
		;;

	rollback)
		[ -d "$workspace" ] && [ ! -L "$workspace" ] ||
			fail 'Transaction workspace is unavailable for rollback.'
		[ -d "$workspace/rollback" ] && [ ! -L "$workspace/rollback" ] ||
			fail 'Rollback data is unavailable.'
		validate_manifest "$workspace/new-manifest"

		if [ -f "$workspace/old-manifest" ]; then
			validate_manifest "$workspace/old-manifest"
		else
			[ -f "$workspace/old-manifest-absent" ] ||
				fail 'The previous manifest state is unavailable.'
		fi

		if rollback_transaction; then
			printf 'Previous component set restored.\n'
		else
			fail 'Automatic rollback failed; transaction evidence was retained.'
		fi
		;;

	commit)
		[ -d "$workspace" ] && [ ! -L "$workspace" ] ||
			fail 'Transaction workspace is unavailable for commit.'
		[ -f "$workspace/switched" ] || fail 'The component switch has not completed.'
		validate_manifest "$workspace/new-manifest"
		validate_manifest "$canonical_manifest"
		[ "$(cat "$canonical_manifest")" = "$(cat "$workspace/new-manifest")" ] ||
			fail 'Canonical component manifest changed before commit.'
		tab=$(printf '\t')

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file) assert_component_type "$type" "$wordpress_root/$component" ;;
			esac
		done < "$workspace/new-manifest"

		while IFS="$tab" read -r type component extra || [ -n "$type$component$extra" ]; do
			case "$type" in
				directory|file)
					[ ! -e "$wordpress_root/$component" ] && [ ! -L "$wordpress_root/$component" ] ||
						fail "Removed component reappeared before commit: $component"
					;;
			esac
		done < "$workspace/removed-components"

		[ ! -e "$maintenance_file" ] && [ ! -L "$maintenance_file" ] ||
			fail 'Filesystem maintenance mode remains active before commit.'
		rm -rf "$workspace"
		printf 'Deployment transaction committed.\n'
		;;

	cleanup)
		if [ -f "$workspace/switched" ]; then
			fail 'Refusing pre-switch cleanup after a completed component switch.'
		fi

		if [ -e "$workspace" ] || [ -L "$workspace" ]; then
			[ -d "$workspace" ] && [ ! -L "$workspace" ] ||
				fail 'Refusing to clean an invalid transaction workspace.'
			rm -rf "$workspace"
		fi

		printf 'Pre-switch transaction data cleaned.\n'
		;;

	*) fail "Unknown deployment mode: $mode" ;;
esac
