#!/usr/bin/env bash
# Rebase the checked-out branch onto the furthest eligible upstream tag, then
# update that same origin branch only if its remote tip is still the checked-out HEAD.
set -euo pipefail

fail() {
	printf 'sync-upstream-tags: %s\n' "$*" >&2
	exit 1
}

if [[ $# -ne 2 ]]; then
	fail "usage: $0 <target-branch> <upstream-url>"
fi

target_branch=$1
upstream_url=$2
[[ -n "$target_branch" ]] || fail "target branch must not be empty"
[[ -n "$upstream_url" ]] || fail "upstream URL must not be empty"

branch_ref="refs/heads/$target_branch"
git check-ref-format "$branch_ref" >/dev/null || fail "invalid target branch: $target_branch"

current_branch=$(git symbolic-ref --quiet --short HEAD) || fail "HEAD is detached; check out the target branch first"
[[ "$current_branch" == "$target_branch" ]] || fail "checked-out branch '$current_branch' does not match target '$target_branch'"
expected_head=$(git rev-parse --verify --end-of-options 'HEAD^{commit}')

# Keep upstream refs out of refs/tags and out of the origin remote-tracking namespace.
ref_namespace=refs/sync-upstream-tags
upstream_branch_ref="$ref_namespace/heads/$target_branch"
upstream_tags_ref="$ref_namespace/tags"
branch_refspec="+$branch_ref:$upstream_branch_ref"
tag_refspec="+refs/tags/*:$upstream_tags_ref/*"
git fetch --force --prune --no-tags "$upstream_url" "$branch_refspec" "$tag_refspec"

upstream_head=$(git rev-parse --verify --end-of-options "$upstream_branch_ref^{commit}")
if merge_base=$(git merge-base "$expected_head" "$upstream_head"); then
	:
else
	fail "checked-out HEAD and upstream '$target_branch' have no merge base"
fi

is_ancestor() {
	local ancestor=$1 descendant=$2 status
	if git merge-base --is-ancestor "$ancestor" "$descendant"; then
		return 0
	else
		status=$?
		[[ $status -eq 1 ]] && return 1
		fail "git merge-base --is-ancestor failed with status $status"
	fi
}

tag_output=$(git for-each-ref --sort=version:refname --format='%(refname)' "$upstream_tags_ref")
tag_refs=()
if [[ -n "$tag_output" ]]; then
	while IFS= read -r tag_ref; do
		[[ -n "$tag_ref" ]] && tag_refs+=("$tag_ref")
	done <<< "$tag_output"
fi

candidate_refs=()
candidate_commits=()
for tag_ref in "${tag_refs[@]}"; do
	# Peel annotated tags all the way to their target object. Tree/blob tags are
	# valid refs but not usable release points; broken or unreadable refs fail.
	if peeled_object=$(git rev-parse --verify --end-of-options "$tag_ref^{}"); then
		:
	else
		fail "could not peel fetched tag ref $tag_ref"
	fi
	if object_type=$(git cat-file -t "$peeled_object"); then
		:
	else
		fail "could not read peeled target of tag ref $tag_ref"
	fi
	case "$object_type" in
		commit) tag_commit=$peeled_object ;;
		tree|blob) continue ;;
		*) fail "unexpected peeled object type '$object_type' for tag ref $tag_ref" ;;
	esac

	# Tags must advance strictly beyond the fork point, be on upstream's branch,
	# and still represent commits absent from the checked-out branch.
	[[ "$tag_commit" != "$merge_base" ]] || continue
	is_ancestor "$merge_base" "$tag_commit" || continue
	is_ancestor "$tag_commit" "$upstream_head" || continue
	if is_ancestor "$tag_commit" "$expected_head"; then
		continue
	fi
	candidate_refs+=("$tag_ref")
	candidate_commits+=("$tag_commit")
done

if [[ ${#candidate_refs[@]} -eq 0 ]]; then
	printf 'sync-upstream-tags: no eligible upstream tags for %s; nothing to do\n' "$target_branch"
	exit 0
fi

# First discard every candidate that is an ancestor of another eligible tag.
# Remaining incomparable tips use the version-sorted tag order above as a stable tie-break.
maximal_indices=()
for ((i = 0; i < ${#candidate_refs[@]}; i++)); do
	dominated=0
	for ((j = 0; j < ${#candidate_refs[@]}; j++)); do
		[[ $i -ne $j ]] || continue
		[[ "${candidate_commits[$i]}" != "${candidate_commits[$j]}" ]] || continue
		if is_ancestor "${candidate_commits[$i]}" "${candidate_commits[$j]}"; then
			dominated=1
			break
		fi
	done
	[[ $dominated -eq 0 ]] && maximal_indices+=("$i")
done

# `tag_refs` came from `for-each-ref --sort=version:refname`, so the last
# maximal entry is the deterministic version-order tie-break winner.
selected_index=${maximal_indices[0]}
for index in "${maximal_indices[@]}"; do
	selected_index=$index
done
selected_tag=${candidate_refs[$selected_index]}
selected_commit=${candidate_commits[$selected_index]}
printf 'sync-upstream-tags: rebasing %s onto tag %s (%s), from merge base %s\n' \
	"$target_branch" "${selected_tag#"$upstream_tags_ref/"}" "$selected_commit" "$merge_base"

if git rebase --rebase-merges --onto "$selected_commit" "$merge_base"; then
	:
else
	status=$?
	printf 'sync-upstream-tags: rebase failed with status %s; refusing to push\n' "$status" >&2
	exit "$status"
fi

git push --force-with-lease="refs/heads/$target_branch:$expected_head" \
	origin "HEAD:refs/heads/$target_branch"
