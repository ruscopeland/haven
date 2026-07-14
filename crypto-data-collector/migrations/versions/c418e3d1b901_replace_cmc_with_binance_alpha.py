"""replace CoinMarketCap caches with Binance Alpha caches

Revision ID: c418e3d1b901
Revises: a52ee57a1071
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c418e3d1b901"
down_revision: Union[str, Sequence[str], None] = "a52ee57a1071"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # CMC cache rows cannot identify Alpha assets, so intentionally discard them.
    op.drop_table("candle_coverage")
    op.drop_table("market_candles")
    op.drop_table("cmc_assets")
    op.create_table(
        "alpha_assets",
        sa.Column("alpha_id", sa.String(), primary_key=True),
        sa.Column("symbol", sa.String(), nullable=False, index=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("rank", sa.Integer(), index=True),
        sa.Column("chain_id", sa.String(), nullable=False, index=True),
        sa.Column("contract_address", sa.String(), index=True),
        sa.Column("metadata_json", sa.Text()),
        sa.Column("fetched_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False, index=True),
    )
    op.create_table(
        "market_candles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("alpha_id", sa.String(), nullable=False, index=True),
        sa.Column("contract_address", sa.String(), index=True, server_default=""),
        sa.Column("interval", sa.String(), nullable=False, index=True),
        sa.Column("open_time", sa.BigInteger(), nullable=False, index=True),
        sa.Column("close_time", sa.BigInteger(), nullable=False),
        sa.Column("open_price", sa.Float(), nullable=False),
        sa.Column("high_price", sa.Float(), nullable=False),
        sa.Column("low_price", sa.Float(), nullable=False),
        sa.Column("close_price", sa.Float(), nullable=False),
        sa.Column("volume", sa.Float(), server_default="0"),
        sa.Column("trader_count", sa.Integer()),
        sa.Column("closed", sa.Integer(), server_default="1", index=True),
        sa.Column("source", sa.String(), server_default="binance_alpha"),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("alpha_id", "contract_address", "interval", "open_time", name="uq_market_candle_identity"),
    )
    op.create_table(
        "candle_coverage",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("alpha_id", sa.String(), nullable=False, index=True),
        sa.Column("contract_address", sa.String(), nullable=False),
        sa.Column("interval", sa.String(), nullable=False),
        sa.Column("start_time", sa.BigInteger(), nullable=False),
        sa.Column("end_time", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("alpha_id", "contract_address", "interval", name="uq_candle_coverage_identity"),
    )
    with op.batch_alter_table("tokens") as batch:
        batch.add_column(sa.Column("alpha_rank", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("alpha_id", sa.String(), nullable=True))
        batch.create_index("ix_tokens_alpha_id", ["alpha_id"])
        batch.drop_column("cmc_rank")
        batch.drop_column("cmc_slug")
        batch.drop_column("cmc_id")


def downgrade() -> None:
    with op.batch_alter_table("tokens") as batch:
        batch.add_column(sa.Column("cmc_rank", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("cmc_slug", sa.String(), nullable=True))
        batch.add_column(sa.Column("cmc_id", sa.Integer(), nullable=True))
        batch.drop_index("ix_tokens_alpha_id")
        batch.drop_column("alpha_rank")
        batch.drop_column("alpha_id")
    op.drop_table("candle_coverage")
    op.drop_table("market_candles")
    op.drop_table("alpha_assets")
    op.create_table(
        "cmc_assets", sa.Column("cmc_id", sa.Integer(), primary_key=True),
        sa.Column("symbol", sa.String(), nullable=False), sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False), sa.Column("rank", sa.Integer()),
        sa.Column("platform", sa.String()), sa.Column("contract_address", sa.String()),
        sa.Column("metadata_json", sa.Text()), sa.Column("fetched_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
    )
    for name, columns in (
        ("ix_cmc_assets_contract_address", ["contract_address"]),
        ("ix_cmc_assets_expires_at", ["expires_at"]),
        ("ix_cmc_assets_platform", ["platform"]),
        ("ix_cmc_assets_rank", ["rank"]),
        ("ix_cmc_assets_slug", ["slug"]),
        ("ix_cmc_assets_symbol", ["symbol"]),
    ):
        op.create_index(name, "cmc_assets", columns)
    op.create_table(
        "market_candles", sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("cmc_id", sa.Integer(), index=True), sa.Column("platform", sa.String(), index=True),
        sa.Column("contract_address", sa.String(), index=True), sa.Column("interval", sa.String(), nullable=False, index=True),
        sa.Column("open_time", sa.BigInteger(), nullable=False, index=True), sa.Column("close_time", sa.BigInteger(), nullable=False),
        sa.Column("open_price", sa.Float(), nullable=False), sa.Column("high_price", sa.Float(), nullable=False),
        sa.Column("low_price", sa.Float(), nullable=False), sa.Column("close_price", sa.Float(), nullable=False),
        sa.Column("volume", sa.Float()), sa.Column("trader_count", sa.Integer()), sa.Column("closed", sa.Integer(), index=True),
        sa.Column("source", sa.String()), sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("cmc_id", "platform", "contract_address", "interval", "open_time", name="uq_market_candle_identity"),
    )
    op.create_table(
        "candle_coverage", sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("cmc_id", sa.Integer(), nullable=False, index=True), sa.Column("platform", sa.String(), nullable=False),
        sa.Column("contract_address", sa.String(), nullable=False), sa.Column("interval", sa.String(), nullable=False),
        sa.Column("start_time", sa.BigInteger(), nullable=False), sa.Column("end_time", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("cmc_id", "platform", "contract_address", "interval", name="uq_candle_coverage_identity"),
    )
